/**
 * Worker manager.
 *
 * Owns the mapping page → plugin → adapter → worker, serialises the tasks of a
 * single worker (one browser tab can only do one thing at a time) while letting
 * different workers run fully in parallel, and keeps status/descriptors fresh.
 *
 * It can serve several `SessionProvider`s at once — typically the Chrome
 * extension (real tabs) plus the built-in simulator (headless providers) —
 * which is how the same runtime backs both production and CI.
 */
import { Emitter } from './events.js';
import { AbortedError, NotFoundError, PageUnavailableError, TimeoutError, toErrorPayload } from './errors.js';
import type { PluginRegistry } from './registry.js';
import type { SessionEvents, SessionProvider } from './session-provider.js';
import type {
  ActionDescriptor,
  FileUpload,
  Logger,
  PageSession,
  PageSnapshot,
  PluginId,
  ResponseResult,
  SendMessageOptions,
  SendMessageResult,
  WorkerDescriptor,
  WorkerId,
  WorkerStatus,
} from './types.js';
import { silentLogger } from './logger.js';

export interface WorkerManagerEvents {
  'worker.added': WorkerDescriptor;
  'worker.updated': WorkerDescriptor;
  'worker.removed': { id: WorkerId; reason?: string };
  'task.started': { workerId: WorkerId; taskId: string; message: string; at: number };
  'task.progress': { workerId: WorkerId; taskId: string; text: string; at: number };
  'task.completed': { workerId: WorkerId; taskId: string; response: string; durationMs: number; at: number };
  'task.failed': { workerId: WorkerId; taskId: string; error: { code: string; message: string }; at: number };
  'provider.attached': { kind: string; sessions: number };
  'provider.detached': { kind: string; reason?: string };
  sessions: SessionEvents[keyof SessionEvents] & { kind: keyof SessionEvents };
}

interface WorkerRecord {
  id: WorkerId;
  pluginId: string;
  pluginName: string;
  session: PageSession;
  provider: SessionProvider | null;
  capabilities: string[];
  createdAt: number;
  updatedAt: number;
  status: WorkerStatus;
  lastError?: string;
  queue: Promise<unknown>;
  taskCounts: { total: number; completed: number; failed: number };
  currentTask?: {
    id: string;
    message: string;
    startedAt: number;
    controller: AbortController;
    done: Promise<ResponseResult>;
    resolve: (value: ResponseResult) => void;
    reject: (error: unknown) => void;
    streamingText: string;
  };
  lastResponse?: ResponseResult;
}

export interface WorkerManagerOptions {
  registry: PluginRegistry;
  provider?: SessionProvider;
  providers?: SessionProvider[];
  logger?: Logger;
  defaultTimeoutMs?: number;
  /** Poll the page status in the background so `list_workers` stays truthful. */
  statusPollMs?: number;
}

export class WorkerManager {
  readonly events = new Emitter<WorkerManagerEvents>();
  #registry: PluginRegistry;
  #logger: Logger;
  #providers: SessionProvider[] = [];
  #workers = new Map<WorkerId, WorkerRecord>();
  #bySession = new Map<string, WorkerId>();
  #counters = new Map<string, number>();
  #taskSequence = 0;
  #defaultTimeoutMs: number;
  #unsubscribers: Array<() => void> = [];
  #started = false;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #statusPollMs: number;

  constructor(options: WorkerManagerOptions) {
    this.#registry = options.registry;
    this.#logger = options.logger ?? silentLogger;
    this.#providers = options.providers ?? (options.provider ? [options.provider] : []);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 180_000;
    this.#statusPollMs = options.statusPollMs ?? 0;
  }

  get registry(): PluginRegistry {
    return this.#registry;
  }

  get providers(): SessionProvider[] {
    return [...this.#providers];
  }

  /** First provider — used when a caller does not care which one owns a page. */
  get provider(): SessionProvider | null {
    return this.#providers[0] ?? null;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const provider of this.#providers) {
      this.#bindProvider(provider);
      const sessions = await provider.connect();
      // `connect()` resolves with the pages that already exist; providers also
      // emit `added` for them, so registration is idempotent by design.
      for (const session of sessions) this.#registerSession(session, provider);
    }
    if (this.#statusPollMs > 0) {
      this.#statusTimer = setInterval(() => void this.refreshStatuses().catch(() => undefined), this.#statusPollMs);
    }
  }

  /** Attach a provider at runtime (e.g. the extension connects later, or reconnects). */
  async addProvider(provider: SessionProvider): Promise<PageSession[]> {
    const existing = this.#providers.find((candidate) => candidate.kind === provider.kind && candidate === provider);
    if (existing) return [];
    this.#providers.push(provider);
    if (this.#started) this.#bindProvider(provider);
    const sessions = await provider.connect();
    for (const session of sessions) this.#registerSession(session, provider);
    this.events.emit('provider.attached', { kind: provider.kind, sessions: sessions.length });
    return sessions;
  }

  async removeProvider(provider: SessionProvider): Promise<void> {
    this.#providers = this.#providers.filter((candidate) => candidate !== provider);
    for (const [id, record] of [...this.#workers]) {
      if (record.provider !== provider) continue;
      this.#workers.delete(id);
      this.#bySession.delete(record.session.id);
      this.events.emit('worker.removed', { id, reason: 'provider-detached' });
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#statusTimer) {
      clearInterval(this.#statusTimer);
      this.#statusTimer = null;
    }
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    for (const provider of this.#providers) {
      await provider.disconnect?.().catch(() => undefined);
    }
    this.#workers.clear();
    this.#bySession.clear();
  }

  #bindProvider(provider: SessionProvider): void {
    this.#unsubscribers.push(
      provider.events.on('added', ({ session }) => {
        this.#registerSession(session, provider);
      }),
      provider.events.on('removed', ({ sessionId, reason }) => this.#removeSession(sessionId, reason)),
      provider.events.on('updated', ({ session }) => {
        const id = this.#bySession.get(session.id);
        const record = id ? this.#workers.get(id) : undefined;
        if (!record) return;
        record.session = session;
        record.capabilities = session.capabilities?.length ? session.capabilities : record.capabilities;
        void this.#touch(record);
      }),
      provider.events.on('detached', ({ reason }) => {
        for (const [id, record] of [...this.#workers]) {
          if (record.provider !== provider) continue;
          record.status = 'offline';
          this.#workers.delete(id);
          this.#bySession.delete(record.session.id);
          this.events.emit('worker.updated', this.#descriptor(record));
          this.events.emit('worker.removed', { id, reason: reason ?? 'provider-detached' });
        }
        this.events.emit('provider.detached', { kind: provider.kind, reason });
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Worker lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  #registerSession(session: PageSession, provider: SessionProvider | null = this.provider): WorkerDescriptor {
    const existingId = this.#bySession.get(session.id);
    if (existingId) {
      const record = this.#workers.get(existingId)!;
      record.session = session;
      return this.#descriptor(record);
    }
    const counter = (this.#counters.get(session.pluginId) ?? 0) + 1;
    this.#counters.set(session.pluginId, counter);
    const id: WorkerId = `${session.pluginId}-${counter}`;
    const plugin = this.#registry.get(session.pluginId);
    const record: WorkerRecord = {
      id,
      pluginId: session.pluginId,
      pluginName: plugin?.name ?? session.pluginId,
      session,
      provider,
      capabilities: session.capabilities ?? plugin?.capabilities() ?? ['chat'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      queue: Promise.resolve(),
      taskCounts: { total: 0, completed: 0, failed: 0 },
    };
    this.#workers.set(id, record);
    this.#bySession.set(session.id, id);
    const descriptor = this.#descriptor(record);
    this.#logger.info('worker registered', { id, provider: record.pluginId, location: session.location });
    this.events.emit('worker.added', descriptor);
    void this.#refreshStatus(record);
    return descriptor;
  }

  #removeSession(sessionId: string, reason?: string): void {
    const id = this.#bySession.get(sessionId);
    if (!id) return;
    const record = this.#workers.get(id)!;
    record.status = 'offline';
    this.#workers.delete(id);
    this.#bySession.delete(sessionId);
    this.events.emit('worker.updated', this.#descriptor(record));
    this.events.emit('worker.removed', { id, reason });
    this.#logger.info('worker removed', { id, reason });
  }

  /** Create (or reuse) a page for a provider and register it as a worker. */
  async openWorker(request: { provider?: PluginId; url?: string; reuse?: boolean }): Promise<WorkerDescriptor> {
    if (request.reuse !== false) {
      const reusable = this.listWorkers().find(
        (worker) =>
          (request.provider ? worker.provider === request.provider : true) &&
          (request.url ? shareOrigin(worker.url, request.url) : true) &&
          worker.status !== 'offline',
      );
      if (reusable) return reusable;
    }
    let lastError: unknown = null;
    for (const provider of this.#providers) {
      if (!provider.open) continue;
      try {
        const session = await provider.open({ provider: request.provider, url: request.url, reuse: false });
        const registered = this.#bySession.get(session.id);
        if (registered) return this.#descriptor(this.#workers.get(registered)!);
        return this.#registerSession(session, provider);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new PageUnavailableError('No session provider is connected: open a browser tab with the extension or start the simulator');
  }

  async closeWorker(ref: string): Promise<{ id: WorkerId; closed: boolean }> {
    const record = this.#require(ref);
    const provider = record.provider;
    if (provider && record.session.close) {
      await provider.close(record.session.id).catch((error) => {
        this.#logger.warn('failed to close session', { id: record.id, error: String(error) });
      });
    }
    this.#removeSession(record.session.id, 'closed-by-agent');
    return { id: record.id, closed: true };
  }

  listWorkers(): WorkerDescriptor[] {
    return [...this.#workers.values()].map((record) => this.#descriptor(record));
  }

  getWorker(ref: string): WorkerDescriptor {
    return this.#descriptor(this.#require(ref));
  }

  hasWorker(ref: string): boolean {
    return this.#resolveRecord(ref) !== null;
  }

  /**
   * Workers can be addressed by full id (`deepseek-1`), by provider (`deepseek`)
   * or by plugin name — agents should not have to remember which tab was which.
   */
  #resolveRecord(ref: string): WorkerRecord | null {
    if (!ref) return null;
    const direct = this.#workers.get(ref);
    if (direct) return direct;
    const byProvider = [...this.#workers.values()].filter((record) => record.pluginId === ref);
    if (byProvider.length) return byProvider[byProvider.length - 1]!;
    const byName = [...this.#workers.values()].filter((record) => record.pluginName === ref);
    if (byName.length) return byName[byName.length - 1]!;
    const prefix = [...this.#workers.values()].filter((record) => record.id.startsWith(`${ref}-`));
    if (prefix.length) return prefix[prefix.length - 1]!;
    return null;
  }

  #require(ref: string): WorkerRecord {
    const record = this.#resolveRecord(ref);
    if (!record) {
      throw new NotFoundError(`Unknown worker "${ref}"`, { available: this.listWorkers().map((worker) => worker.id) });
    }
    return record;
  }

  /* ------------------------------------------------------------------ */
  /* Task execution                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Enqueue a message. The returned promise resolves when the message has been
   * submitted (and, when `waitForResponse` is on, when the answer is complete).
   */
  async sendMessage(ref: string, message: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
    const record = this.#require(ref);
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new PageUnavailableError('message must be a non-empty string');
    }
    const taskId = `task-${++this.#taskSequence}`;
    const waitForResponse = options.waitForResponse ?? true;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    const task = this.#createTask(record, taskId, message);
    record.taskCounts.total += 1;
    // The worker itself always drives the page until the answer is complete —
    // `waitForResponse` only decides whether *this call* awaits it or returns
    // `accepted` so the agent can poll with `get_response`.
    record.status = 'busy';
    record.queue = record.queue
      .catch(() => undefined)
      .then(() => this.#runTask(record, task, { ...options, timeoutMs }));

    const accepted: SendMessageResult = { workerId: record.id, taskId, acceptedAt: task.startedAt };
    if (!waitForResponse) return accepted;
    const result = await task.done;
    return { ...accepted, response: result.response, durationMs: result.durationMs };
  }

  #createTask(record: WorkerRecord, taskId: string, message: string): NonNullable<WorkerRecord['currentTask']> {
    let resolve!: (value: ResponseResult) => void;
    let reject!: (error: unknown) => void;
    const controller = new AbortController();
    const done = new Promise<ResponseResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that only want "accepted" must not trigger unhandled rejections.
    done.catch(() => undefined);
    const task = { id: taskId, message, startedAt: Date.now(), controller, done, resolve, reject, streamingText: '' };
    record.currentTask = task;
    return task;
  }

  async #runTask(
    record: WorkerRecord,
    task: NonNullable<WorkerRecord['currentTask']>,
    options: SendMessageOptions & { timeoutMs: number },
  ): Promise<void> {
    const { id: taskId, message } = task;
    record.status = 'busy';
    const started = Date.now();
    this.events.emit('worker.updated', this.#descriptor(record));
    this.events.emit('task.started', { workerId: record.id, taskId, message, at: started });
    this.#logger.info('task started', { worker: record.id, taskId, chars: message.length });

    try {
      if (task.controller.signal.aborted) throw new AbortedError('Task was cancelled before it started');
      await record.session.adapter.sendMessage(message, {
        ...options,
        waitForResponse: false,
        files: options.files as FileUpload[] | undefined,
      });

      const response = await record.session.adapter.waitForResponse({
        timeoutMs: options.timeoutMs,
        partial: options.partial ?? true,
        signal: task.controller.signal,
        onProgress: (text) => {
          task.streamingText = text;
          this.events.emit('task.progress', { workerId: record.id, taskId, text, at: Date.now() });
        },
      });

      const result: ResponseResult = {
        workerId: record.id,
        taskId,
        response,
        durationMs: Date.now() - started,
        at: Date.now(),
      };
      record.lastResponse = result;
      record.taskCounts.completed += 1;
      record.lastError = undefined;
      this.events.emit('task.completed', {
        workerId: record.id,
        taskId,
        response,
        durationMs: result.durationMs,
        at: result.at,
      });
      task.resolve(result);
      this.#logger.info('task completed', { worker: record.id, taskId, chars: response.length });
    } catch (error) {
      const payload = toErrorPayload(error);
      record.taskCounts.failed += 1;
      record.lastError = `${payload.code}: ${payload.message}`;
      const partialText = task.streamingText;
      if (error instanceof TimeoutError && partialText) {
        record.lastResponse = {
          workerId: record.id,
          taskId,
          response: partialText,
          durationMs: Date.now() - started,
          at: Date.now(),
          partial: true,
        };
      }
      this.events.emit('task.failed', { workerId: record.id, taskId, error: payload, at: Date.now() });
      this.#logger.warn('task failed', { worker: record.id, taskId, error: payload.message });
      task.reject(error);
    } finally {
      if (record.currentTask?.id === taskId) {
        record.currentTask = undefined;
        await this.#refreshStatus(record);
      } else {
        // Another message is already queued: the worker stays busy.
        record.status = 'busy';
        await this.#touch(record);
      }
    }
  }

  /**
   * Return the answer produced by the last (or given) task. When the worker is
   * still busy the call waits for the current task to finish.
   */
  async getResponse(ref: string, options: { taskId?: string; wait?: boolean; timeoutMs?: number } = {}): Promise<ResponseResult> {
    const record = this.#require(ref);
    const wait = options.wait ?? true;
    const current = record.currentTask;
    if (current && wait) {
      const timer = options.timeoutMs
        ? new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new TimeoutError(`Timed out waiting for worker "${record.id}" response`)),
              options.timeoutMs,
            ),
          )
        : null;
      try {
        return await (timer ? Promise.race([current.done, timer]) : current.done);
      } catch (error) {
        if (record.lastResponse && record.lastResponse.taskId === current.id) return record.lastResponse;
        if (current.streamingText) {
          return {
            workerId: record.id,
            taskId: current.id,
            response: current.streamingText,
            durationMs: Date.now() - current.startedAt,
            at: Date.now(),
            partial: true,
          };
        }
        throw new PageUnavailableError(`Task ${current.id} failed: ${toErrorPayload(error).message}`);
      }
    }
    if (options.taskId) {
      if (record.lastResponse?.taskId === options.taskId) return record.lastResponse;
      throw new NotFoundError(`No response recorded for task "${options.taskId}" on worker "${record.id}"`);
    }
    if (current) {
      // A task is still running while `wait: false` — report what we have.
      return {
        workerId: record.id,
        taskId: current.id,
        response: current.streamingText,
        durationMs: Date.now() - current.startedAt,
        at: Date.now(),
        partial: true,
      };
    }
    if (!record.lastResponse) {
      throw new NotFoundError(`Worker "${record.id}" has not produced a response yet`);
    }
    return record.lastResponse;
  }

  async snapshot(ref: string, options: { transcript?: boolean } = {}): Promise<PageSnapshot> {
    const record = this.#require(ref);
    const snapshot = await record.session.adapter.snapshot();
    const enriched: PageSnapshot = {
      ...snapshot,
      workerId: record.id,
      provider: record.pluginId,
      capabilities: snapshot.capabilities?.length ? snapshot.capabilities : record.capabilities,
      meta: { ...snapshot.meta, tasks: { ...record.taskCounts }, tabId: record.session.tabId },
    };
    if (options.transcript === false) enriched.transcript = [];
    record.status = enriched.status;
    record.updatedAt = Date.now();
    return enriched;
  }

  getCapabilities(ref: string): { workerId: WorkerId; provider: PluginId; capabilities: string[] } {
    const record = this.#require(ref);
    return { workerId: record.id, provider: record.pluginId, capabilities: [...record.capabilities] };
  }

  async actions(ref: string): Promise<ActionDescriptor[]> {
    return (await this.snapshot(ref)).availableActions;
  }

  async invoke(ref: string, actionId: string, value?: unknown): Promise<unknown> {
    const record = this.#require(ref);
    if (!record.session.adapter.invoke) {
      throw new PageUnavailableError(`Plugin "${record.pluginId}" does not support page actions`);
    }
    const result = await record.session.adapter.invoke(actionId, value);
    await this.#refreshStatus(record);
    return result;
  }

  async stopWorker(ref: string): Promise<{ id: WorkerId; stopped: boolean; cancelledTask?: string }> {
    const record = this.#require(ref);
    const task = record.currentTask;
    task?.controller.abort();
    if (record.session.adapter.stop) {
      await record.session.adapter.stop().catch((error) => {
        this.#logger.warn('adapter.stop failed', { worker: record.id, error: String(error) });
      });
    }
    record.status = 'ready';
    await this.#touch(record);
    return { id: record.id, stopped: true, cancelledTask: task?.id };
  }

  async newChat(ref: string): Promise<{ id: WorkerId; ok: boolean }> {
    const record = this.#require(ref);
    if (!record.session.adapter.newChat) {
      throw new PageUnavailableError(`Plugin "${record.pluginId}" cannot start a new chat`);
    }
    await record.session.adapter.newChat();
    record.lastResponse = undefined;
    await this.#refreshStatus(record);
    return { id: record.id, ok: true };
  }

  async navigate(ref: string, url: string): Promise<{ id: WorkerId; url: string }> {
    const record = this.#require(ref);
    const provider = record.provider;
    if (!provider?.navigate) throw new PageUnavailableError('Session provider does not support navigation');
    await provider.navigate(record.session.id, url);
    record.status = 'waiting';
    await this.#touch(record);
    return { id: record.id, url };
  }

  async focus(ref: string): Promise<{ id: WorkerId; focused: boolean }> {
    const record = this.#require(ref);
    const provider = record.provider;
    if (!provider?.focus) return { id: record.id, focused: false };
    await provider.focus(record.session.id);
    return { id: record.id, focused: true };
  }

  /* ------------------------------------------------------------------ */
  /* Status bookkeeping                                                  */
  /* ------------------------------------------------------------------ */

  async refreshStatuses(): Promise<WorkerDescriptor[]> {
    await Promise.all([...this.#workers.values()].map((record) => this.#refreshStatus(record)));
    return this.listWorkers();
  }

  async #refreshStatus(record: WorkerRecord): Promise<void> {
    if (record.currentTask) {
      record.status = 'busy';
      return;
    }
    let status: WorkerStatus;
    try {
      status = await record.session.adapter.getStatus();
    } catch (error) {
      status = 'error';
      record.lastError = toErrorPayload(error).message;
    }
    record.status = status;
    await this.#touch(record);
  }

  async #touch(record: WorkerRecord): Promise<void> {
    record.updatedAt = Date.now();
    // Descriptors are derived from cheap fields only: snapshotting the DOM on
    // every status poll would be wasteful, and it stays a pull operation.
    this.events.emit('worker.updated', this.#descriptor(record));
  }

  #descriptor(record: WorkerRecord): WorkerDescriptor {
    return {
      id: record.id,
      provider: record.pluginId,
      pluginName: record.pluginName,
      status: record.status,
      capabilities: [...record.capabilities],
      url: record.session.url,
      title: record.session.title,
      tabId: record.session.tabId,
      sessionId: record.session.id,
      location: record.session.location,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastError: record.lastError,
      tasks: {
        total: record.taskCounts.total,
        completed: record.taskCounts.completed,
        failed: record.taskCounts.failed,
        current: record.currentTask?.id,
      },
    };
  }
}

function shareOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.startsWith(b) || b.startsWith(a);
  }
}
