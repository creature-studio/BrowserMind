/**
 * `SelectorAdapter` — 95 % of every plugin.
 *
 * A plugin author declares a `SelectorPack` and gets a complete, streaming
 * aware, status aware adapter. Nothing in here knows which website it is
 * driving, which is exactly why adding Gemini never requires touching core code.
 */
import type {
  ActionDescriptor,
  AIAdapter,
  DomDriverLike,
  FileUpload,
  PageSnapshot,
  PluginContext,
  SendMessageOptions,
  TranscriptEntry,
  WaitForResponseOptions,
  WorkerStatus,
} from '../types.js';
import { AbortedError, PageUnavailableError, TimeoutError } from '../errors.js';
import { hasAnySelector, joinSelectors, validatePack, type SelectorPack } from './selectors.js';

export interface SelectorAdapterOptions {
  pluginId: string;
  capabilities: string[];
  pack: SelectorPack;
  /** Page state labels surfaced in snapshots (`meta.state`). */
  states?: Partial<Record<'blocked' | 'busy' | 'ready' | 'waiting', string>>;
  pageUrl?: string;
}

interface TaskState {
  id: string;
  message: string;
  startedAt: number;
  baselineCount: number;
  baselineText: string;
  response?: string;
  completed: boolean;
}

export class SelectorAdapter implements AIAdapter {
  readonly pluginId: string;
  readonly #pack: SelectorPack;
  readonly #driver: DomDriverLike;
  readonly #log: PluginContext['logger'];
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #capabilities: string[];
  #task: TaskState | null = null;
  #transcript: TranscriptEntry[] = [];
  #lastStatus: WorkerStatus = 'idle';
  #taskCounter = 0;
  #options: SelectorAdapterOptions;

  constructor(context: PluginContext, options: SelectorAdapterOptions) {
    validatePack(options.pack);
    this.#options = options;
    this.pluginId = options.pluginId;
    this.#pack = options.pack;
    this.#driver = context.driver;
    this.#log = context.logger.child(options.pluginId);
    this.#now = context.now;
    this.#sleep = context.sleep;
    this.#capabilities = options.capabilities;
  }

  get driver(): DomDriverLike {
    return this.#driver;
  }

  get pack(): SelectorPack {
    return this.#pack;
  }

  capabilities(): string[] {
    return [...this.#capabilities];
  }

  /* ------------------------------------------------------------------ */
  /* Locating page parts                                                 */
  /* ------------------------------------------------------------------ */

  async #findInput(timeoutMs = this.#pack.stepTimeoutMs ?? 8_000) {
    const selector = joinSelectors(this.#pack.input);
    const handle = await this.#driver.query({ selector, visible: true, timeoutMs });
    if (handle) return handle;
    // Editor containers (ProseMirror, Lexical…) sometimes report as invisible
    // through computed styles; fall back to the raw match.
    return this.#driver.query({ selector });
  }

  async #findResponse(): Promise<{ handle: NonNullable<Awaited<ReturnType<DomDriverLike['query']>>>; text: string } | null> {
    if (!hasAnySelector(this.#pack.response)) return null;
    const selector = joinSelectors(this.#pack.response);
    const handle = await this.#driver.query({ selector, index: -1, visible: true });
    if (!handle) return null;
    const text = await this.#driver.text(handle);
    return { handle, text };
  }

  async #responseCount(): Promise<number> {
    if (!hasAnySelector(this.#pack.response)) return 0;
    return this.#driver.count({ selector: joinSelectors(this.#pack.response), visible: true });
  }

  async #isBlocked(): Promise<boolean> {
    if (!hasAnySelector(this.#pack.blocked)) return false;
    return this.#driver.exists({ selector: joinSelectors(this.#pack.blocked), visible: true });
  }

  async #isStreaming(): Promise<boolean> {
    if (!hasAnySelector(this.#pack.streaming)) return false;
    const visible = await this.#driver.exists({ selector: joinSelectors(this.#pack.streaming), visible: true });
    if (visible) return true;
    if (hasAnySelector(this.#pack.stopButton)) {
      return this.#driver.exists({ selector: joinSelectors(this.#pack.stopButton), visible: true });
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Adapter API                                                         */
  /* ------------------------------------------------------------------ */

  async sendMessage(message: string, options: SendMessageOptions = {}): Promise<void> {
    if (await this.#isBlocked()) {
      throw new PageUnavailableError(`Provider "${this.pluginId}" page requires attention (login/quota)`, {
        provider: this.pluginId,
      });
    }

    if (options.options?.newChat === true && this.newChat) {
      await this.newChat();
    }

    if (options.files?.length) {
      await this.#uploadFiles(options.files);
    }

    const baselineCount = await this.#responseCount();
    const current = await this.#findResponse();
    const taskId = `t${++this.#taskCounter}`;
    this.#task = {
      id: taskId,
      message,
      startedAt: this.#now(),
      baselineCount,
      baselineText: current?.text ?? '',
      completed: false,
    };

    const input = await this.#findInput();
    if (!input) {
      this.#task = null;
      throw new PageUnavailableError(`Could not find the message composer on the ${this.pluginId} page`, {
        selectors: this.#pack.input,
      });
    }

    await this.#driver.scrollIntoView(input);
    await this.#driver.type(input, message, { mode: this.#inputMode(), clear: true });

    const submitKeys = this.#pack.submitKeys ?? ['Enter'];
    const primaryKey = submitKeys[0] ?? 'Enter';
    if (primaryKey === 'Enter') {
      await this.#driver.press(input, 'Enter');
    } else if (primaryKey !== 'Shift+Enter' && hasAnySelector(this.#pack.sendButton)) {
      await this.#submitViaButton();
    } else {
      await this.#driver.press(input, 'Enter');
    }

    this.#transcript.push({ role: 'user', text: message, at: this.#now() });
    this.#lastStatus = 'busy';
    this.#log.debug('message submitted', { taskId, baselineCount });
  }

  async waitForResponse(options: WaitForResponseOptions = {}): Promise<string> {
    const task = this.#task;
    if (!task) throw new PageUnavailableError('waitForResponse() called before sendMessage()');

    if (!hasAnySelector(this.#pack.response)) {
      // Capability-free providers: nothing to observe, report an explicit error
      // rather than returning an empty string.
      throw new PageUnavailableError(`Plugin "${this.pluginId}" does not declare response selectors`);
    }

    const timeoutMs = options.timeoutMs ?? 180_000;
    const quietMs = this.#pack.quietMs ?? 900;
    const pollMs = this.#pack.pollMs ?? 150;
    const responseSelector = joinSelectors(this.#pack.response);
    const started = this.#now();

    let lastText = '';
    let lastChangeAt = this.#now();
    let sawOwnReply = false;

    for (;;) {
      if (options.signal?.aborted) throw new AbortedError();

      const count = await this.#responseCount();
      const found = await this.#findResponse();
      const text = found?.text ?? '';

      // The reply belongs to this task when a new bubble appeared…
      if (count > task.baselineCount) sawOwnReply = true;
      // …or when the newest bubble changed (single-container layouts).
      if (text && text !== task.baselineText) sawOwnReply = true;

      if (text !== lastText) {
        lastText = text;
        lastChangeAt = this.#now();
        if (sawOwnReply) options.onProgress?.(text);
      }

      if (sawOwnReply) {
        const streaming = await this.#isStreaming();
        const stableFor = this.#now() - lastChangeAt;
        if (!streaming && lastText.trim().length > 0 && stableFor >= quietMs) {
          task.response = lastText;
          task.completed = true;
          this.#lastStatus = 'ready';
          this.#transcript.push({ role: 'assistant', text: lastText, at: this.#now() });
          this.#log.debug('response captured', { taskId: task.id, chars: lastText.length });
          return lastText;
        }
      }

      if (this.#now() - started >= timeoutMs) {
        task.completed = false;
        this.#lastStatus = 'error';
        if (options.partial && lastText) return lastText;
        throw new TimeoutError(
          `Timed out after ${timeoutMs}ms waiting for a ${this.pluginId} response` +
            (lastText ? ` (partial reply: ${lastText.slice(0, 120)}…)` : ''),
          { provider: this.pluginId, timeoutMs, sawOwnReply },
        );
      }

      await this.#sleep(pollMs);
    }
  }

  async getStatus(): Promise<WorkerStatus> {
    if (await this.#isBlocked()) return (this.#lastStatus = 'blocked');
    if (await this.#isStreaming()) return (this.#lastStatus = 'busy');
    if (hasAnySelector(this.#pack.busy) && (await this.#driver.exists({ selector: joinSelectors(this.#pack.busy), visible: true }))) {
      return (this.#lastStatus = 'busy');
    }
    const input = await this.#findInput(1_500);
    if (input) return (this.#lastStatus = 'ready');
    return (this.#lastStatus = 'waiting');
  }

  async snapshot(): Promise<PageSnapshot> {
    const info = await this.#driver.info();
    const status = await this.getStatus();
    const actions = await this.#actions();
    const transcript = await this.transcript();
    return {
      workerId: '',
      provider: this.pluginId,
      url: this.#options.pageUrl ?? info.url,
      title: info.title,
      state: this.#stateLabel(status),
      status,
      capabilities: this.capabilities(),
      availableActions: actions,
      transcript,
      busy: status === 'busy',
      at: this.#now(),
      meta: {
        taskId: this.#task?.id,
        lastMessage: this.#task?.message,
        responseChars: this.#task?.response?.length ?? 0,
      },
    };
  }

  async transcript(): Promise<TranscriptEntry[]> {
    const limit = this.#pack.transcriptLimit ?? 12;
    const entries: TranscriptEntry[] = [];
    const assistantSelector = joinSelectors(this.#pack.response);
    const userSelector = joinSelectors(this.#pack.userMessage);

    const [assistants, users] = await Promise.all([
      assistantSelector
        ? this.#driver.queryAll({ selector: assistantSelector, visible: true })
        : Promise.resolve([]),
      userSelector ? this.#driver.queryAll({ selector: userSelector, visible: true }) : Promise.resolve([]),
    ]);

    for (const element of assistants) {
      entries.push({ role: 'assistant', text: await this.#driver.text(element), at: this.#now() });
    }
    for (const element of users) {
      entries.push({ role: 'user', text: await this.#driver.text(element), at: this.#now() });
    }
    // Site DOM order is not exposed by ElementHandle refs, so fall back to our
    // locally recorded turns when they are richer than the DOM walk.
    const merged = entries.length > 0 ? entries : this.#transcript;
    const tail = merged.slice(-limit);
    if (users.length === 0) {
      // Interleave the user turns we observed ourselves.
      const local = this.#transcript.filter((entry) => entry.role === 'user');
      const withUsers = [...tail];
      for (const entry of local.slice(-limit)) {
        if (!withUsers.some((candidate) => candidate.text === entry.text)) {
          withUsers.unshift(entry);
        }
      }
      return withUsers.slice(-limit * 2);
    }
    return tail;
  }

  async stop(): Promise<void> {
    if (!hasAnySelector(this.#pack.stopButton)) {
      throw new PageUnavailableError(`Plugin "${this.pluginId}" cannot stop generation`);
    }
    const handle = await this.#driver.query({ selector: joinSelectors(this.#pack.stopButton), visible: true });
    if (!handle) return;
    await this.#driver.click(handle);
    this.#lastStatus = 'ready';
  }

  async newChat(): Promise<void> {
    if (!hasAnySelector(this.#pack.newChat)) {
      throw new PageUnavailableError(`Plugin "${this.pluginId}" cannot start a new chat`);
    }
    const handle = await this.#driver.query({ selector: joinSelectors(this.#pack.newChat), visible: true });
    if (handle) await this.#driver.click(handle);
    this.#task = null;
    this.#lastStatus = 'ready';
  }

  /** Execute a page action previously advertised through `snapshot().availableActions`. */
  async invoke(actionId: string, value?: unknown): Promise<unknown> {
    if (actionId === 'stop') {
      await this.stop();
      return { ok: true };
    }
    if (actionId === 'new-chat') {
      await this.newChat();
      return { ok: true };
    }
    if (actionId === 'chat') {
      const input = await this.#findInput();
      if (!input) throw new PageUnavailableError('Composer is not available');
      return { ok: true, input };
    }
    const action = this.#pack.actions?.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new PageUnavailableError(`Unknown action "${actionId}" for plugin "${this.pluginId}"`, {
        available: (this.#pack.actions ?? []).map((candidate) => candidate.id),
      });
    }
    const handle = await this.#driver.query({ selector: action.selector, visible: true });
    if (!handle) throw new PageUnavailableError(`Action "${actionId}" target is not present on the page`);
    if (action.kind === 'toggle') {
      const stateSelector = action.stateSelector ?? action.selector;
      const stateHandle = await this.#driver.query({ selector: stateSelector, visible: false });
      const current = stateHandle ? (await this.#driver.attr(stateHandle, 'aria-checked')) === 'true' : false;
      const next = typeof value === 'boolean' ? value : !current;
      await this.#driver.check(stateHandle ?? handle, next);
      return { ok: true, value: next };
    }
    await this.#driver.click(handle);
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  async #uploadFiles(files: FileUpload[]): Promise<void> {
    let fileInputSelector = joinSelectors(this.#pack.fileInput);
    if (!fileInputSelector) {
      throw new PageUnavailableError(`Plugin "${this.pluginId}" does not support file upload`);
    }
    if (hasAnySelector(this.#pack.attachButton)) {
      const attach = await this.#driver.query({ selector: joinSelectors(this.#pack.attachButton), visible: true });
      if (attach) {
        await this.#driver.click(attach);
        await this.#sleep(120);
      }
    }
    let input = await this.#driver.query({ selector: fileInputSelector });
    if (!input) {
      // Hidden inputs are usually revealed after the attach button opens a menu.
      input = await this.#driver.waitFor(fileInputSelector, { timeoutMs: 3_000 }).catch(() => null);
    }
    if (!input) throw new PageUnavailableError(`Could not find the file input on the ${this.pluginId} page`);
    await this.#driver.upload(input, files);
    this.#log.debug('files attached', { count: files.length });
  }

  async #submitViaButton(): Promise<void> {
    const selector = joinSelectors(this.#pack.sendButton);
    if (!selector) {
      throw new PageUnavailableError(`Plugin "${this.pluginId}" has no send button and no Enter submit key`);
    }
    const handle = await this.#driver.query({ selector, visible: true, timeoutMs: this.#pack.stepTimeoutMs ?? 8_000 });
    if (!handle) throw new PageUnavailableError(`Send button not found for plugin "${this.pluginId}"`);
    await this.#driver.click(handle);
  }

  #inputMode(): 'auto' | 'value' | 'insertText' | 'keys' {
    return 'auto';
  }

  #stateLabel(status: WorkerStatus): string {
    const labels = this.#options.states ?? {};
    switch (status) {
      case 'blocked':
        return labels.blocked ?? 'blocked';
      case 'busy':
        return labels.busy ?? 'generating';
      case 'ready':
        return labels.ready ?? 'ready';
      case 'waiting':
        return labels.waiting ?? 'waiting';
      default:
        return status;
    }
  }

  async #actions(): Promise<ActionDescriptor[]> {
    const actions: ActionDescriptor[] = [];
    const input = await this.#findInput(1_000);
    actions.push({
      id: 'chat',
      label: 'Send a chat message',
      kind: 'chat',
      enabled: Boolean(input),
      reason: input ? undefined : 'Composer not found (page still loading or login required)',
    });

    if (hasAnySelector(this.#pack.stopButton)) {
      const stopHandle = await this.#driver.query({ selector: joinSelectors(this.#pack.stopButton), visible: true });
      actions.push({
        id: 'stop',
        label: 'Stop generation',
        kind: 'click',
        enabled: Boolean(stopHandle),
      });
    }
    if (hasAnySelector(this.#pack.newChat)) {
      const handle = await this.#driver.query({ selector: joinSelectors(this.#pack.newChat), visible: true });
      actions.push({ id: 'new-chat', label: 'Start a new chat', kind: 'click', enabled: Boolean(handle) });
    }
    if (hasAnySelector(this.#pack.fileInput)) {
      const handle = await this.#driver.query({ selector: joinSelectors(this.#pack.fileInput), visible: false });
      actions.push({
        id: 'attach-file',
        label: 'Attach a file',
        kind: 'upload',
        enabled: Boolean(handle),
        reason: handle ? undefined : 'No file input mounted yet',
      });
    }
    for (const action of this.#pack.actions ?? []) {
      const handle = await this.#driver.query({ selector: action.selector, visible: true });
      const descriptor: ActionDescriptor = {
        id: action.id,
        label: action.label,
        kind: action.kind === 'toggle' ? 'toggle' : 'click',
        enabled: Boolean(handle),
      };
      if (action.kind === 'toggle') {
        const stateSelector = action.stateSelector ?? action.selector;
        const stateHandle = await this.#driver.query({ selector: stateSelector, visible: false });
        descriptor.value = stateHandle ? (await this.#driver.attr(stateHandle, 'aria-checked')) === 'true' : false;
      }
      actions.push(descriptor);
    }
    return actions;
  }
}

/** Factory used by plugin folders: `createSelectorAdapter(context, pack, opts)`. */
export function createSelectorAdapter(
  context: PluginContext,
  options: SelectorAdapterOptions,
): SelectorAdapter {
  return new SelectorAdapter(context, options);
}
