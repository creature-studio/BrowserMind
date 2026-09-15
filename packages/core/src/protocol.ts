/**
 * Runtime ⇄ Extension protocol.
 *
 * High level on purpose: the DOM never crosses the wire. The runtime asks for
 * *intentions* (`sendMessage`, `waitForResponse`, `snapshot`) and the page-side
 * adapter decides how to satisfy them. Third-party plugins that must not run
 * inside the page can additionally tunnel raw DOM calls through `dom.call`.
 *
 * The same code is used by:
 *   - the WebSocket transport (runtime ⇄ extension background)
 *   - a local channel pair (tests, simulator, in-process embedding)
 */
import { Emitter } from './events.js';
import { createRemoteDomDriver, DOM_RPC_METHODS, type DomRpcMethod } from './dom/remote.js';
import type { RpcPeer } from './rpc.js';
import type { SessionEvents, SessionProvider, OpenSessionRequest } from './session-provider.js';
import type {
  AIAdapter,
  DomDriverLike,
  ExecutionLocation,
  FileUpload,
  PageSession,
  PageSnapshot,
  PluginDescriptor,
  SendMessageOptions,
  TranscriptEntry,
  WorkerStatus,
} from './types.js';
import { NotFoundError, toErrorPayload } from './errors.js';

export const SESSION_METHODS = {
  list: 'session.list',
  open: 'session.open',
  close: 'session.close',
  navigate: 'session.navigate',
  reload: 'session.reload',
  focus: 'session.focus',
  status: 'session.status',
  snapshot: 'session.snapshot',
  capabilities: 'session.capabilities',
  sendMessage: 'session.sendMessage',
  waitForResponse: 'session.waitForResponse',
  transcript: 'session.transcript',
  stop: 'session.stop',
  newChat: 'session.newChat',
  invoke: 'session.invoke',
  domCall: 'dom.call',
  catalog: 'plugin.catalog',
  heartbeat: 'runtime.heartbeat',
} as const;

export const SESSION_EVENTS = {
  added: 'session.added',
  removed: 'session.removed',
  updated: 'session.updated',
  progress: 'session.progress',
  detached: 'session.detached',
  hello: 'session.hello',
  log: 'runtime.log',
} as const;

/** Methods the *runtime* serves to connected extensions. */
export const RUNTIME_METHODS = {
  /** Current runtime state (workers + plugin catalog) — pulled on connect. */
  state: 'runtime.state',
  /** Pushed whenever the worker inventory changes. */
  workers: 'runtime.workers',
  /** Pushed whenever the plugin catalog changes. */
  plugins: 'plugin.catalog',
  /** Pushed for every worker/task event, so extension pages can stream live. */
  events: 'runtime.events',
  /**
   * `browser_ai.*` calls an extension page makes on behalf of a human
   * (the standalone console). Handled by the runtime's tool table.
   */
  request: 'extension.request',
} as const;

/** Methods/events an extension is expected to send. */
export const EXTENSION_METHODS = {
  hello: 'extension.hello',
  request: 'extension.request',
} as const;

/** Serializable description of a page. */
export interface SessionInfo {
  id: string;
  pluginId: string;
  url: string;
  title?: string;
  tabId?: number;
  capabilities: string[];
  location: ExecutionLocation;
  /** Optional plugin metadata so the runtime can render a catalog. */
  plugin?: PluginDescriptor;
}

export interface DomCallParams {
  sessionId: string;
  method: DomRpcMethod;
  args: unknown[];
}

export interface ProgressEvent {
  sessionId: string;
  taskId?: string;
  text: string;
}

export interface ServeSessionProviderOptions {
  /** Called whenever the page list changes (tab opened/closed/navigated). */
  list: () => Promise<SessionInfo[]> | SessionInfo[];
  open: (request: OpenSessionRequest) => Promise<SessionInfo>;
  /** Returns the live page session, including its adapter and driver. */
  getSession: (sessionId: string) => Promise<PageSession> | PageSession | undefined;
  close?: (sessionId: string) => Promise<void>;
  navigate?: (sessionId: string, url: string) => Promise<void>;
  reload?: (sessionId: string) => Promise<void>;
  focus?: (sessionId: string) => Promise<void>;
  heartbeat?: () => Promise<unknown>;
  /** Push an event from the extension side (`session.added`, `session.progress`…). */
  notify: (method: string, params: unknown) => void;
}

/**
 * Server half: implement the protocol on top of *something that owns pages*.
 * The extension background uses it to expose Chrome tabs + content scripts.
 */
export function serveSessionProvider(peer: RpcPeer, options: ServeSessionProviderOptions): { pushList(): Promise<SessionInfo[]> } {
  const requireSession = async (sessionId: string): Promise<PageSession> => {
    const session = await options.getSession(sessionId);
    if (!session) throw new NotFoundError(`Session "${sessionId}" is no longer available`);
    return session;
  };

  peer.handle(SESSION_METHODS.list, () => options.list());
  peer.handle(SESSION_METHODS.open, (params: OpenSessionRequest) => options.open(params));
  peer.handle(SESSION_METHODS.close, async ({ sessionId }: { sessionId: string }) => {
    if (!options.close) throw new NotFoundError('Closing sessions is not supported by this provider');
    await options.close(sessionId);
    options.notify(SESSION_EVENTS.removed, { sessionId, reason: 'closed' });
    return { ok: true };
  });
  peer.handle(SESSION_METHODS.navigate, async ({ sessionId, url }: { sessionId: string; url: string }) => {
    if (!options.navigate) throw new NotFoundError('Navigation is not supported by this provider');
    await options.navigate(sessionId, url);
    return { ok: true };
  });
  peer.handle(SESSION_METHODS.reload, async ({ sessionId }: { sessionId: string }) => {
    if (!options.reload) throw new NotFoundError('Reload is not supported by this provider');
    await options.reload(sessionId);
    return { ok: true };
  });
  peer.handle(SESSION_METHODS.focus, async ({ sessionId }: { sessionId: string }) => {
    if (!options.focus) return { ok: false };
    await options.focus(sessionId);
    return { ok: true };
  });

  peer.handle(SESSION_METHODS.status, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    return session.adapter.getStatus();
  });
  peer.handle(SESSION_METHODS.snapshot, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    return session.adapter.snapshot();
  });
  peer.handle(SESSION_METHODS.capabilities, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    return session.capabilities;
  });
  peer.handle(SESSION_METHODS.transcript, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    if (!session.adapter.transcript) return [];
    return session.adapter.transcript();
  });
  peer.handle(
    SESSION_METHODS.sendMessage,
    async ({
      sessionId,
      message,
      options: sendOptions,
    }: {
      sessionId: string;
      message: string;
      options?: SendMessageOptions;
    }) => {
      const session = await requireSession(sessionId);
      await session.adapter.sendMessage(message, { ...sendOptions, waitForResponse: false });
      return { ok: true, taskId: (sendOptions?.options?.taskId as string | undefined) ?? undefined };
    },
  );
  peer.handle(
    SESSION_METHODS.waitForResponse,
    async ({
      sessionId,
      taskId,
      timeoutMs,
      partial,
    }: {
      sessionId: string;
      taskId?: string;
      timeoutMs?: number;
      partial?: boolean;
    }) => {
      const session = await requireSession(sessionId);
      const text = await session.adapter.waitForResponse({
        timeoutMs,
        partial,
        onProgress: (text) => options.notify(SESSION_EVENTS.progress, { sessionId, taskId, text }),
      });
      return { text };
    },
  );
  peer.handle(SESSION_METHODS.stop, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    if (!session.adapter.stop) throw new NotFoundError('Stop is not supported by this plugin');
    await session.adapter.stop();
    return { ok: true };
  });
  peer.handle(SESSION_METHODS.newChat, async ({ sessionId }: { sessionId: string }) => {
    const session = await requireSession(sessionId);
    if (!session.adapter.newChat) throw new NotFoundError('New chat is not supported by this plugin');
    await session.adapter.newChat();
    return { ok: true };
  });
  peer.handle(SESSION_METHODS.invoke, async ({ sessionId, actionId, value }: { sessionId: string; actionId: string; value?: unknown }) => {
    const session = await requireSession(sessionId);
    if (!session.adapter.invoke) throw new NotFoundError('Page actions are not supported by this plugin');
    return session.adapter.invoke(actionId, value);
  });

  const DOM_METHOD_SET = new Set<string>(DOM_RPC_METHODS as readonly string[]);
  peer.handle(SESSION_METHODS.domCall, async ({ sessionId, method, args }: DomCallParams) => {
    if (!DOM_METHOD_SET.has(method)) throw new NotFoundError(`Unknown DOM method "${method}"`);
    const session = await requireSession(sessionId);
    const driver = session.domDriver;
    if (!driver) throw new NotFoundError(`Session "${sessionId}" does not expose its DOM driver`);
    const fn = (driver as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
    if (typeof fn !== 'function') throw new NotFoundError(`DOM method "${method}" is not implemented`);
    return fn.apply(driver, args);
  });

  if (options.heartbeat) peer.handle(SESSION_METHODS.heartbeat, () => options.heartbeat!());

  return { async pushList() {
    const sessions = await options.list();
    options.notify(SESSION_EVENTS.updated, { sessions });
    return sessions;
  } };
}

/** Client half: turns a peer into a `SessionProvider` (+ remote adapters). */
export function createRemoteSessionProvider(
  peer: RpcPeer,
  options: { location?: ExecutionLocation; log?: (message: string, meta?: Record<string, unknown>) => void } = {},
): SessionProvider & { info: Map<string, SessionInfo> } {
  const events = new Emitter<SessionEvents>();
  const info = new Map<string, SessionInfo>();
  const location: ExecutionLocation = options.location ?? 'page';

  const toSession = (record: SessionInfo): PageSession => {
    info.set(record.id, record);
    return {
      id: record.id,
      pluginId: record.pluginId,
      url: record.url,
      title: record.title,
      tabId: record.tabId,
      capabilities: record.capabilities,
      location: record.location ?? location,
      adapter: createRemoteAdapter(peer, record.id, record.pluginId),
      domDriver: createSessionDomDriver(peer, record.id),
      close: async () => {
        await peer.request(SESSION_METHODS.close, { sessionId: record.id });
      },
      navigate: async (url: string) => {
        await peer.request(SESSION_METHODS.navigate, { sessionId: record.id, url });
      },
      reload: async () => {
        await peer.request(SESSION_METHODS.reload, { sessionId: record.id });
      },
      focus: async () => {
        await peer.request(SESSION_METHODS.focus, { sessionId: record.id });
      },
    };
  };

  peer.onEvent((event) => {
    const params = event.params as Record<string, unknown> | undefined;
    switch (event.method) {
      case SESSION_EVENTS.added:
      case SESSION_EVENTS.updated: {
        if (params && Array.isArray((params as { sessions?: SessionInfo[] }).sessions)) {
          for (const record of (params as { sessions: SessionInfo[] }).sessions) {
            const existed = info.has(record.id);
            const session = toSession(record);
            events.emit(existed ? 'updated' : 'added', { session });
          }
          return;
        }
        const record = (params?.session ?? params) as SessionInfo | undefined;
        if (!record?.id) return;
        const existed = info.has(record.id);
        const session = toSession(record);
        events.emit(existed ? 'updated' : 'added', { session });
        return;
      }
      case SESSION_EVENTS.removed: {
        const sessionId = (params?.sessionId ?? params?.id) as string | undefined;
        if (!sessionId) return;
        info.delete(sessionId);
        events.emit('removed', { sessionId, reason: params?.reason as string | undefined });
        return;
      }
      case SESSION_EVENTS.detached:
        events.emit('detached', { reason: params?.reason as string | undefined });
        return;
      default:
        return;
    }
  });

  const provider: SessionProvider & { info: Map<string, SessionInfo> } = {
    kind: location,
    events,
    info,
    async connect() {
      const sessions = (await peer.request<SessionInfo[]>(SESSION_METHODS.list)) ?? [];
      const list: PageSession[] = [];
      for (const record of sessions) {
        const existed = info.has(record.id);
        const session = toSession(record);
        list.push(session);
        events.emit(existed ? 'updated' : 'added', { session });
      }
      events.emit('attached', { sessions: list });
      return list;
    },
    async disconnect() {
      peer.close();
    },
    async open(request) {
      const record = await peer.request<SessionInfo>(SESSION_METHODS.open, request);
      const session = toSession(record);
      events.emit('added', { session });
      return session;
    },
    async close(sessionId) {
      await peer.request(SESSION_METHODS.close, { sessionId });
      info.delete(sessionId);
      events.emit('removed', { sessionId, reason: 'closed' });
    },
    async navigate(sessionId, url) {
      await peer.request(SESSION_METHODS.navigate, { sessionId, url });
    },
    async reload(sessionId) {
      await peer.request(SESSION_METHODS.reload, { sessionId });
    },
    async focus(sessionId) {
      await peer.request(SESSION_METHODS.focus, { sessionId });
    },
    log: options.log,
  };
  return provider;
}

/** Remote adapter: page-side adapter driven over the wire. */
export function createRemoteAdapter(peer: RpcPeer, sessionId: string, pluginId: string): AIAdapter {
  const progressListeners = new Set<(text: string) => void>();
  peer.onEvent((event) => {
    if (event.method !== SESSION_EVENTS.progress) return;
    const params = event.params as ProgressEvent | undefined;
    if (!params || params.sessionId !== sessionId) return;
    for (const listener of [...progressListeners]) listener(params.text);
  });

  return {
    async sendMessage(message: string, options: SendMessageOptions = {}): Promise<void> {
      await peer.request(SESSION_METHODS.sendMessage, {
        sessionId,
        message,
        options: { ...options, waitForResponse: false },
      });
    },
    async waitForResponse(options = {}): Promise<string> {
      const { onProgress, signal, timeoutMs, partial } = options;
      if (onProgress) progressListeners.add(onProgress);
      const onAbort = () => {
        void peer.request(SESSION_METHODS.stop, { sessionId }).catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await peer.request<{ text: string }>(
          SESSION_METHODS.waitForResponse,
          { sessionId, timeoutMs, partial },
          (timeoutMs ?? 180_000) + 10_000,
        );
        return result.text;
      } finally {
        if (onProgress) progressListeners.delete(onProgress);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    async getStatus(): Promise<WorkerStatus> {
      return peer.request<WorkerStatus>(SESSION_METHODS.status, { sessionId });
    },
    async snapshot(): Promise<PageSnapshot> {
      return peer.request<PageSnapshot>(SESSION_METHODS.snapshot, { sessionId });
    },
    async capabilities(): Promise<string[]> {
      return peer.request<string[]>(SESSION_METHODS.capabilities, { sessionId }).catch(() => []);
    },
    async transcript(): Promise<TranscriptEntry[]> {
      return peer.request<TranscriptEntry[]>(SESSION_METHODS.transcript, { sessionId }).catch(() => []);
    },
    async stop(): Promise<void> {
      await peer.request(SESSION_METHODS.stop, { sessionId });
    },
    async newChat(): Promise<void> {
      await peer.request(SESSION_METHODS.newChat, { sessionId });
    },
    async invoke(actionId: string, value?: unknown): Promise<unknown> {
      return peer.request(SESSION_METHODS.invoke, { sessionId, actionId, value });
    },
    get providerId() {
      return pluginId;
    },
  } as AIAdapter;
}

/** DOM driver for third-party (sandboxed) plugins: every call is tunnelled. */
export function createSessionDomDriver(peer: RpcPeer, sessionId: string, options: { timeoutMs?: number } = {}): DomDriverLike {
  const driver = createRemoteDomDriver(peer, { location: 'remote', timeoutMs: options.timeoutMs ?? 0 });
  const call = <T>(method: DomRpcMethod, args: unknown[], timeoutMs?: number): Promise<T> =>
    peer.request<T>(SESSION_METHODS.domCall, { sessionId, method, args } satisfies DomCallParams, timeoutMs ?? 0);
  return {
    ...driver,
    location: 'remote',
    query: (args) => call('query', [args]),
    queryAll: (args) => call('queryAll', [args]),
    count: (args) => call('count', [args]),
    exists: (args) => call('exists', [args]),
    text: (target, opts) => call('text', [target, opts]),
    attr: (target, name) => call('attr', [target, name]),
    value: (target) => call('value', [target]),
    isVisible: (target) => call('isVisible', [target]),
    click: (target, opts) => call('click', [target, opts]),
    type: (target, text, opts) => call('type', [target, text, opts]),
    press: (target, key, opts) => call('press', [target, key, opts]),
    check: (target, checked) => call('check', [target, checked]),
    scrollIntoView: (target) => call('scrollIntoView', [target]),
    upload: (target, files: FileUpload[]) => call('upload', [target, files]),
    waitFor: (selector, opts) => call('waitFor', [selector, opts]),
    observeText: (target, opts) => call('observeText', [target, opts]),
    info: () => call('info', []),
  };
}

export { toErrorPayload };
