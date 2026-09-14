/**
 * Runtime bridge (background side).
 *
 * Maintains the WebSocket to the BrowserMind runtime, reconnects with backoff,
 * serves the extension's pages to the runtime and mirrors the runtime's plugin
 * catalog back into the extension.
 */
import {
  RpcPeer,
  RUNTIME_METHODS,
  createLogger,
  createWebSocketChannel,
  type Logger,
  type MessageChannelLike,
  type PluginDescriptor,
  type PluginManifest,
  type SessionInfo,
} from '@browsermind/core/browser';
import { getSettings } from './settings';
import type { TabManager } from './tab-manager';

export interface BridgeState {
  connected: boolean;
  url: string;
  lastError?: string;
  connectedAt?: number;
  attempts: number;
}

export type RuntimeMessageChannel = MessageChannelLike;

const EXTENSION_HELLO = 'extension.hello';

export class RuntimeBridge {
  readonly logger: Logger;
  state: BridgeState = { connected: false, url: '', attempts: 0 };
  #socket: WebSocket | null = null;
  #peer: RpcPeer | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #tabs: TabManager;
  #onChange: (() => void) | null = null;
  #workers: unknown[] = [];
  #plugins: PluginDescriptor[] = [];
  #lastError: string | undefined;

  constructor(tabs: TabManager, logger?: Logger) {
    this.#tabs = tabs;
    this.logger = logger ?? createLogger({ level: 'info', scope: 'bridge' });
  }

  get connected(): boolean {
    return this.state.connected;
  }

  get workerSnapshot(): unknown[] {
    return this.#workers;
  }

  get pluginCatalog(): PluginDescriptor[] {
    return this.#plugins;
  }

  set onChange(handler: () => void) {
    this.#onChange = handler;
  }

  async connect(): Promise<void> {
    if (this.#socket && (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)) return;
    const settings = await getSettings();
    this.state.url = settings.runtimeUrl;
    this.#closed = false;
    try {
      const socket = new WebSocket(settings.runtimeUrl);
      this.#socket = socket;
      // The runtime starts talking the moment the handshake completes (its
      // first act is listing our sessions), so the peer exists before the
      // socket opens — the buffering channel keeps both directions safe.
      const peer = new RpcPeer(createWebSocketChannel(socket), {
        name: 'runtime',
        timeoutMs: 0,
        onError: (error, meta) => this.logger.warn('rpc error', { ...meta, error: error.message }),
      });
      this.#peer = peer;
      // Wire the protocol *now*: the runtime asks for our session list the
      // moment the handshake completes, so nothing may wait for `open`.
      this.#tabs.serve(peer, { heartbeat: async () => ({ at: Date.now() }) });
      this.#tabs.onChange = (sessions) => this.pushSessions(sessions);
      peer.onEvent((event) => this.#onRuntimeEvent(event));
      socket.addEventListener('open', () => this.#onOpen(socket));
      socket.addEventListener('error', () => this.#onError('websocket error'));
      socket.addEventListener('close', () => this.#onClose('websocket closed'));
    } catch (error) {
      this.#onError(String(error));
    }
  }

  #onOpen(socket: WebSocket): void {
    this.logger.info('connected to runtime', { url: this.state.url });
    this.state = { connected: true, url: this.state.url, connectedAt: Date.now(), attempts: 0 };
    if (!this.#peer) return;

    // Announce ourselves and pull the current catalog + worker list.
    void this.#hello();
    void this.pushSessions(this.#tabs.list());
  }

  #onRuntimeEvent(event: { method: string; params: unknown }): void {
    if (event.method === RUNTIME_METHODS.workers) {
      const params = event.params as { workers?: unknown[] } | unknown[];
      this.#workers = Array.isArray(params) ? params : (params?.workers ?? []);
      this.#onChange?.();
      return;
    }
    if (event.method === RUNTIME_METHODS.plugins) {
      const params = event.params as { plugins?: PluginDescriptor[]; manifests?: PluginManifest[] } | undefined;
      this.#plugins = params?.plugins ?? [];
      this.#onChange?.();
      if (params?.manifests?.length) {
        void this.#tabs.syncInstalledManifests(params.manifests).then((registered) => {
          if (registered.length) this.logger.info('installed plugins activated', { ids: registered });
          void this.pushSessions(this.#tabs.list());
        });
      }
      return;
    }
  }

  async #hello(): Promise<void> {
    const manifest = browserManifest();
    this.#peer?.notify(EXTENSION_HELLO, {
      version: manifest.version,
      name: manifest.name,
      plugins: this.#tabs.sessionInfos().length,
    });
    const state = await this.#peer
      ?.request<{ workers?: unknown[]; plugins?: PluginDescriptor[] }>(RUNTIME_METHODS.state, {}, 8_000)
      .catch(() => null);
    if (state) {
      this.#workers = state.workers ?? [];
      this.#plugins = state.plugins ?? [];
      this.#onChange?.();
    }
  }

  pushSessions(sessions: unknown): void {
    const list: SessionInfo[] = Array.isArray(sessions)
      ? (sessions as Array<{ id: string; pluginId: string; url: string; title?: string; tabId?: number; capabilities: string[]; location: string }>).map(
          (session) => ({ ...session, location: session.location as SessionInfo['location'] }),
        )
      : [];
    this.#peer?.notify('session.updated', { sessions: list });
    this.#onChange?.();
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.#peer || !this.state.connected) throw new Error('Runtime is not connected');
    return this.#peer.request<T>(method, params, timeoutMs);
  }

  #onError(message: string): void {
    this.#lastError = message;
    this.state.connected = false;
    this.state.lastError = message;
    this.#onChange?.();
  }

  #onClose(reason: string): void {
    this.logger.warn('runtime connection closed', { reason });
    this.#peer?.close();
    this.#peer = null;
    this.#socket = null;
    this.#onError(reason);
    if (!this.#closed) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.state.attempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.state.attempts - 1));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void getSettings().then((settings) => {
        if (settings.autoReconnect) void this.connect();
      });
    }, delay);
  }

  /** Force a reconnect (used by the popup button). */
  async reconnect(): Promise<void> {
    this.#peer?.close();
    this.#socket?.close();
    this.#socket = null;
    this.#peer = null;
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    await this.connect();
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }
}

function browserManifest(): { version: string; name: string } {
  try {
    const manifest = chrome.runtime.getManifest();
    return { version: manifest.version, name: manifest.name };
  } catch {
    return { version: '0.0.0', name: 'BrowserMind' };
  }
}
