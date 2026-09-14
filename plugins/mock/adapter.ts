/**
 * Mock provider adapter — written **by hand**.
 *
 * Two plugin styles are supported and this folder demonstrates the low-level
 * one: instead of composing `SelectorAdapter`, the plugin implements the
 * `AIAdapter` interface itself. Anything that satisfies the interface is a
 * valid plugin, which is what keeps the core open for exotic providers
 * (canvas based UIs, iframe embeddings, third-party bridges…).
 */
import {
  AbortedError,
  PageUnavailableError,
  TimeoutError,
  createPlugin,
  joinSelectors,
  type AIAdapter,
  type ActionDescriptor,
  type BrowserAIPlugin,
  type DomDriverLike,
  type PageSnapshot,
  type PluginContext,
  type SendMessageOptions,
  type WaitForResponseOptions,
  type TranscriptEntry,
  type WorkerStatus,
} from '@browsermind/core/browser';
import { mockSelectors as pack } from './selectors.js';

interface Turn {
  message: string;
  at: number;
}

class MockAdapter implements AIAdapter {
  #driver: DomDriverLike;
  #context: PluginContext;
  #turns: Turn[] = [];
  #task: { message: string; baseline: number; baselineText: string } | null = null;
  #status: WorkerStatus = 'idle';
  #lastResponse = '';

  constructor(context: PluginContext) {
    this.#context = context;
    this.#driver = context.driver;
  }

  capabilities(): string[] {
    return ['chat', 'file_upload', 'stop', 'new_chat'];
  }

  async #composer() {
    return (await this.#driver.query({ selector: joinSelectors(pack.input), visible: true })) ?? null;
  }

  async sendMessage(message: string, options: SendMessageOptions = {}): Promise<void> {
    if (await this.#driver.exists({ selector: joinSelectors(pack.blocked), visible: true })) {
      throw new PageUnavailableError('The mock provider requires you to sign in first');
    }
    if (options.files?.length) {
      const input = await this.#driver.query({ selector: joinSelectors(pack.fileInput) });
      if (!input) throw new PageUnavailableError('Mock provider file input is not present');
      await this.#driver.upload(input, options.files);
    }

    const composer = await this.#composer();
    if (!composer) throw new PageUnavailableError('Mock provider composer was not found');

    this.#task = {
      message,
      baseline: await this.#driver.count({ selector: joinSelectors(pack.response), visible: true }),
      baselineText: await this.#newestAnswerText(),
    };
    this.#turns.push({ message, at: this.#context.now() });

    await this.#driver.type(composer, message, { mode: 'value', clear: true });
    if ((await this.#driver.value(composer)) !== message) {
      // Some editors normalise whitespace — make sure the site really got it.
      throw new PageUnavailableError('Could not write the message into the mock composer');
    }
    await this.#driver.press(composer, 'Enter');
    this.#status = 'busy';
  }

  async #newestAnswerText(): Promise<string> {
    const handle = await this.#driver.query({ selector: joinSelectors(pack.response), index: -1, visible: true });
    if (!handle) return '';
    return this.#driver.text(handle);
  }

  async waitForResponse(options: WaitForResponseOptions = {}): Promise<string> {
    if (!this.#task) throw new PageUnavailableError('waitForResponse() called before sendMessage()');
    const timeoutMs = options.timeoutMs ?? 60_000;
    const started = this.#context.now();
    let lastText = '';
    let stableSince = this.#context.now();
    let own = false;

    for (;;) {
      if (options.signal?.aborted) throw new AbortedError();
      const count = await this.#driver.count({ selector: joinSelectors(pack.response), visible: true });
      const text = await this.#newestAnswerText();
      if (count > this.#task.baseline || (text && text !== this.#task.baselineText)) own = true;

      if (text !== lastText) {
        lastText = text;
        stableSince = this.#context.now();
        if (own) options.onProgress?.(text);
      }
      const generating = await this.#isGenerating();
      if (own && !generating && lastText.trim() && this.#context.now() - stableSince >= (pack.quietMs ?? 500)) {
        this.#status = 'ready';
        this.#lastResponse = lastText;
        this.#task = null;
        return lastText;
      }
      if (this.#context.now() - started >= timeoutMs) {
        this.#status = 'error';
        if (options.partial && lastText) return lastText;
        throw new TimeoutError(`Mock provider did not answer within ${timeoutMs}ms`);
      }
      await this.#context.sleep(pack.pollMs ?? 100);
    }
  }

  async #isGenerating(): Promise<boolean> {
    return this.#driver.exists({ selector: joinSelectors(pack.streaming), visible: true });
  }

  async getStatus(): Promise<WorkerStatus> {
    if (await this.#driver.exists({ selector: joinSelectors(pack.blocked), visible: true })) {
      return (this.#status = 'blocked');
    }
    if (await this.#isGenerating()) return (this.#status = 'busy');
    return (this.#status = (await this.#composer()) ? 'ready' : 'waiting');
  }

  async snapshot(): Promise<PageSnapshot> {
    const info = await this.#driver.info();
    const status = await this.getStatus();
    return {
      workerId: '',
      provider: 'mock',
      url: info.url,
      title: info.title,
      state: status === 'blocked' ? 'sign-in-required' : status === 'busy' ? 'generating' : status === 'ready' ? 'ready' : 'page-loading',
      status,
      capabilities: this.capabilities(),
      availableActions: await this.#actions(),
      transcript: await this.transcript(),
      busy: status === 'busy',
      at: this.#context.now(),
      meta: { lastResponse: this.#lastResponse.slice(0, 200) },
    };
  }

  async #actions(): Promise<ActionDescriptor[]> {
    const composer = await this.#composer();
    const actions: ActionDescriptor[] = [
      { id: 'chat', label: 'Send a chat message', kind: 'chat', enabled: Boolean(composer) },
    ];
    const stop = await this.#driver.query({ selector: joinSelectors(pack.stopButton), visible: true });
    actions.push({ id: 'stop', label: 'Stop generating', kind: 'click', enabled: Boolean(stop) });
    const newChat = await this.#driver.query({ selector: joinSelectors(pack.newChat), visible: true });
    actions.push({ id: 'new-chat', label: 'Start a new chat', kind: 'click', enabled: Boolean(newChat) });
    const upload = await this.#driver.query({ selector: joinSelectors(pack.fileInput) });
    actions.push({ id: 'attach-file', label: 'Attach a file', kind: 'upload', enabled: Boolean(upload) });
    return actions;
  }

  async transcript(): Promise<TranscriptEntry[]> {
    const limit = pack.transcriptLimit ?? 10;
    const answers = await this.#driver.queryAll({ selector: joinSelectors(pack.response), visible: true });
    const entries: TranscriptEntry[] = [];
    for (const answer of answers.slice(-limit)) {
      entries.push({ role: 'assistant', text: await this.#driver.text(answer), at: this.#context.now() });
    }
    for (const turn of this.#turns.slice(-limit)) {
      entries.push({ role: 'user', text: turn.message, at: turn.at });
    }
    return entries.slice(-limit * 2);
  }

  async stop(): Promise<void> {
    const stop = await this.#driver.query({ selector: joinSelectors(pack.stopButton), visible: true });
    if (!stop) throw new PageUnavailableError('Mock provider is not generating anything');
    await this.#driver.click(stop);
    this.#status = 'ready';
  }

  async newChat(): Promise<void> {
    const button = await this.#driver.query({ selector: joinSelectors(pack.newChat), visible: true });
    if (!button) throw new PageUnavailableError('Mock provider has no new-chat button');
    await this.#driver.click(button);
    this.#turns = [];
    this.#lastResponse = '';
    this.#status = 'ready';
  }

  async invoke(actionId: string): Promise<unknown> {
    if (actionId === 'stop') {
      await this.stop();
      return { ok: true };
    }
    if (actionId === 'new-chat') {
      await this.newChat();
      return { ok: true };
    }
    throw new PageUnavailableError(`Mock provider does not implement action "${actionId}"`);
  }
}

export const mockPlugin: BrowserAIPlugin = createPlugin({
  id: 'mock',
  name: 'Mock Provider',
  version: '1.0.0',
  matchPatterns: ['https://mock.browsermind.local/*'],
  capabilities: ['chat', 'file_upload', 'stop', 'new_chat'],
  description: 'Reference provider: a hand-written AIAdapter used by tests and the simulator.',
  accent: '#8b5cf6',
  metadata: { source: 'builtin' },
  createAdapter: (context) => new MockAdapter(context),
});

export default mockPlugin;
