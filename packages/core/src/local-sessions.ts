/**
 * Local (in-process) session provider.
 *
 * Used by:
 *   - the runtime simulator (`browsermind --simulate all`) so the whole stack —
 *     MCP → runtime → workers → plugins → DOM — can be exercised with no browser;
 *   - the test suite, where every plugin is verified against a fake chat site.
 */
import { Emitter } from './events.js';
import { NotFoundError, ValidationError } from './errors.js';
import { matchAnyPattern } from './match-pattern.js';
import type { PluginRegistry } from './registry.js';
import type { OpenSessionRequest, SessionEvents, SessionProvider } from './session-provider.js';
import type { AIAdapter, ExecutionLocation, Logger, PageSession, PluginContext } from './types.js';
import { createLogger, silentLogger } from './logger.js';

export interface LocalSessionFactoryRequest {
  pluginId: string;
  url: string;
  capabilities: string[];
  /** Plugin context ready to be handed to `plugin.createAdapter`. */
  context: PluginContext;
}

export interface LocalSessionDescriptor {
  pluginId: string;
  url: string;
  title?: string;
  capabilities?: string[];
  /** Return the adapter for this page (usually `plugin.createAdapter(context)`). */
  createAdapter?: (request: LocalSessionFactoryRequest) => AIAdapter | Promise<AIAdapter>;
  /** DOM driver of the simulated page — handed to the plugin context. */
  driver?: PageSession['domDriver'];
  /** Optional DOM driver exposed to sandboxed plugins (same object usually). */
  domDriver?: PageSession['domDriver'];
  close?: () => Promise<void> | void;
}

export interface LocalSessionProviderOptions {
  registry: PluginRegistry;
  logger?: Logger;
  kind?: ExecutionLocation;
  /** Sessions that already exist when `connect()` is called (e.g. simulated tabs). */
  sessions?: LocalSessionDescriptor[];
  /** Called when `open()` needs a page that does not exist yet. */
  factory?: (request: { pluginId: string; url: string }) => Promise<LocalSessionDescriptor | null | undefined> | LocalSessionDescriptor | null | undefined;
}

export class LocalSessionProvider implements SessionProvider {
  readonly kind: ExecutionLocation;
  readonly events = new Emitter<SessionEvents>();
  /** Logger used for the pages created here. */
  logger: Logger;
  #registry: PluginRegistry;
  #descriptors: LocalSessionDescriptor[];
  #factory?: LocalSessionProviderOptions['factory'];
  #sessions = new Map<string, PageSession>();
  #counter = 0;
  /** Descriptors that already produced a page (connect() is idempotent). */
  #materialized = new Map<LocalSessionDescriptor, PageSession>();

  constructor(options: LocalSessionProviderOptions) {
    this.#registry = options.registry;
    this.logger = options.logger ?? silentLogger;
    this.kind = options.kind ?? 'simulator';
    this.#descriptors = [...(options.sessions ?? [])];
    this.#factory = options.factory;
  }

  /** Add a page to the provider (simulator boot, test setup). */
  addSession(descriptor: LocalSessionDescriptor): Promise<PageSession> {
    this.#descriptors.push(descriptor);
    return this.#materialize(descriptor);
  }

  async connect(): Promise<PageSession[]> {
    const sessions: PageSession[] = [];
    for (const descriptor of [...this.#descriptors]) {
      const existing = this.#materialized.get(descriptor);
      sessions.push(existing ?? (await this.#materialize(descriptor)));
    }
    this.events.emit('attached', { sessions });
    return sessions;
  }

  async disconnect(): Promise<void> {
    for (const session of [...this.#sessions.values()]) {
      await session.close?.().catch(() => undefined);
    }
    this.#sessions.clear();
    this.events.emit('detached', { reason: 'provider-shutdown' });
  }

  async open(request: OpenSessionRequest): Promise<PageSession> {
    if (request.reuse !== false) {
      for (const session of this.#sessions.values()) {
        if (request.provider && session.pluginId !== request.provider) continue;
        if (request.url && !urlsShareOrigin(request.url, session.url)) continue;
        return session;
      }
    }
    const plugin = this.#registry.resolve({ provider: request.provider, url: request.url });
    if (!plugin) {
      throw new ValidationError(`Cannot open a page for ${request.provider ?? request.url}: no matching plugin`);
    }
    const url = request.url ?? sampleUrlFor(plugin.describe().matchPatterns, request.provider);
    const descriptor: LocalSessionDescriptor = {
      pluginId: plugin.id,
      url,
      capabilities: plugin.capabilities(),
    };
    const session = await this.#materialize(descriptor);
    return session;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NotFoundError(`Unknown session "${sessionId}"`);
    await session.close?.().catch(() => undefined);
    this.#sessions.delete(sessionId);
    this.events.emit('removed', { sessionId, reason: 'closed' });
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NotFoundError(`Unknown session "${sessionId}"`);
    if (session.navigate) return session.navigate(url);
    session.url = url;
    this.events.emit('updated', { session });
  }

  get(sessionId: string): PageSession | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): PageSession[] {
    return [...this.#sessions.values()];
  }

  async #materialize(descriptor: LocalSessionDescriptor): Promise<PageSession> {
    const plugin = this.#registry.get(descriptor.pluginId);
    if (!plugin) throw new NotFoundError(`Plugin "${descriptor.pluginId}" is not registered`);
    const id = `${descriptor.pluginId}-session-${++this.#counter}`;
    const context: PluginContext = {
      driver: descriptor.driver ?? createUnavailableDriver(),
      logger: this.logger.child(`session:${id}`),
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    const adapter = descriptor.createAdapter
      ? await descriptor.createAdapter({
          pluginId: descriptor.pluginId,
          url: descriptor.url,
          capabilities: descriptor.capabilities ?? plugin.capabilities(),
          context,
        })
      : plugin.createAdapter(context);

    const session: PageSession = {
      id,
      pluginId: descriptor.pluginId,
      url: descriptor.url,
      title: descriptor.title,
      capabilities: descriptor.capabilities ?? plugin.capabilities(),
      location: this.kind,
      adapter,
      domDriver: descriptor.domDriver,
      close: async () => {
        await descriptor.close?.();
      },
      navigate: async (url: string) => {
        session.url = url;
        this.events.emit('updated', { session });
      },
    };
    this.#sessions.set(id, session);
    this.#materialized.set(descriptor, session);
    this.events.emit('added', { session });
    return session;
  }
}

function urlsShareOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/** Turn `https://chat.deepseek.com/*` into `https://chat.deepseek.com/`. */
export function sampleUrlFor(patterns: readonly string[], provider?: string): string {
  const pattern = patterns[0];
  if (!pattern) throw new ValidationError(`Plugin "${provider}" declares no match patterns`);
  const url = pattern
    .replace(/^\*:\/\//, 'https://')
    .replace(/\/\*$/, '/')
    .replace('*.', 'www.')
    .replace(/\*/g, '');
  return url.endsWith('/') || url.includes('/', 'https://'.length) ? url : `${url}/`;
}

/** Driver used when a plugin is instantiated outside of a page. */
function createUnavailableDriver() {
  const fail = () => {
    throw new NotFoundError('No DOM available in this context');
  };
  return {
    location: 'local' as const,
    query: async () => fail(),
    queryAll: async () => fail(),
    count: async () => 0,
    exists: async () => false,
    text: async () => '',
    attr: async () => null,
    value: async () => '',
    isVisible: async () => false,
    click: async () => fail(),
    type: async () => fail(),
    press: async () => fail(),
    check: async () => fail(),
    scrollIntoView: async () => fail(),
    upload: async () => fail(),
    waitFor: async () => fail(),
    observeText: async () => '',
    info: async () => ({ url: '', title: '' }),
  };
}

export { createLogger };
