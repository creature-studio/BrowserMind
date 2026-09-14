/**
 * Extension bridge.
 *
 * A WebSocket server the Chrome extension dials into. One connection carries
 * *everything*: session list, DOM-level calls (for sandboxed plugins), task
 * submission and streaming progress. The protocol itself lives in
 * `@browsermind/core/protocol` so both sides stay in lockstep.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RpcPeer,
  createLogger,
  createRemoteSessionProvider,
  createWebSocketChannel,
  silentLogger,
  type Logger,
  type SessionProvider,
} from '@browsermind/core';
import { Emitter } from '@browsermind/core';

export interface ExtensionClient {
  id: string;
  peer: RpcPeer;
  provider: SessionProvider;
  socket: WebSocket;
  connectedAt: number;
  info: Record<string, unknown>;
}

export interface ExtensionBridgeEvents {
  connected: ExtensionClient;
  disconnected: { id: string; reason?: string };
}

export interface ExtensionBridgeOptions {
  port: number;
  host?: string;
  path?: string;
  logger?: Logger;
  /** Called for every new connection so the owner can attach the provider. */
  onClient: (client: ExtensionClient) => void | Promise<void>;
  onClose?: (client: ExtensionClient) => void | Promise<void>;
}

export class ExtensionBridge {
  readonly events = new Emitter<ExtensionBridgeEvents>();
  #options: ExtensionBridgeOptions;
  #logger: Logger;
  #server: WebSocketServer | null = null;
  #clients = new Map<string, ExtensionClient>();
  #sequence = 0;
  #started = false;

  constructor(options: ExtensionBridgeOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  get port(): number {
    return this.#options.port;
  }

  get clients(): ExtensionClient[] {
    return [...this.#clients.values()];
  }

  get isStarted(): boolean {
    return this.#started;
  }

  listeningPort(): number | null {
    const address = this.#server?.address();
    if (!address || typeof address === 'string') return null;
    return address.port;
  }

  async start(): Promise<number> {
    if (this.#started) return this.listeningPort() ?? this.#options.port;
    const server = new WebSocketServer({
      port: this.#options.port,
      host: this.#options.host ?? '0.0.0.0',
      path: this.#options.path ?? '/browsermind/extension',
      clientTracking: true,
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    server.on('connection', (socket, request) => this.#onConnection(socket, request.headers as Record<string, string>));
    this.#started = true;
    const port = this.listeningPort() ?? this.#options.port;
    this.#logger.info('extension bridge listening', { port, path: this.#options.path ?? '/browsermind/extension' });
    return port;
  }

  #onConnection(socket: WebSocket, headers: Record<string, string>): void {
    const id = `ext-${++this.#sequence}`;
    const channel = createWebSocketChannel(socket);
    const peer = new RpcPeer(channel, {
      name: `extension:${id}`,
      timeoutMs: 120_000,
      onError: (error, meta) => this.#logger.warn('extension rpc error', { id, ...meta, error: error.message }),
    });
    const provider = createRemoteSessionProvider(peer, {
      location: 'page',
      log: (message, meta) => this.#logger.debug(message, meta),
    });
    const client: ExtensionClient = {
      id,
      peer,
      provider,
      socket,
      connectedAt: Date.now(),
      info: {
        userAgent: headers['user-agent'],
        extensionVersion: headers['x-browsermind-version'],
        clientId: headers['x-browsermind-client'],
      },
    };
    this.#clients.set(id, client);
    this.#logger.info('extension connected', { id, ...client.info });
    void Promise.resolve(this.#options.onClient(client)).catch((error) =>
      this.#logger.error('failed to attach extension provider', { id, error: String(error) }),
    );
    this.events.emit('connected', client);

    socket.on('close', () => {
      this.#clients.delete(id);
      this.#logger.info('extension disconnected', { id });
      this.#options.onClose?.(client);
      client.provider.events.emit('detached', { reason: 'extension-disconnected' });
      peer.close();
      this.events.emit('disconnected', { id, reason: 'closed' });
    });
  }

  /** Wait until at least one extension connects (used by the CLI). */
  async waitForClient(timeoutMs = 30_000): Promise<ExtensionClient | null> {
    if (this.#clients.size > 0) return this.clients[0]!;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.events.once('connected', (client) => {
        clearTimeout(timer);
        resolve(client);
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.#clients.values()) {
      client.peer.close();
      client.socket.close();
    }
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    this.#server = null;
    this.#started = false;
  }
}

export { createLogger };
