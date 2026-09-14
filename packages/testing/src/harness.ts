/**
 * Harness helpers: glue a fake site together with a real plugin so tests (and
 * `browsermind --simulate`) run the exact production code path.
 */
import {
  LocalSessionProvider,
  PluginRegistry,
  createLogger,
  silentLogger,
  WorkerManager,
  type AIAdapter,
  type BrowserAIPlugin,
  type ExecutionLocation,
  type Logger,
  type PageSession,
  type PluginContext,
  SelectorAdapter,
  matchAnyPattern,
  type PluginManifest,
  type SelectorPack,
} from '../../core/src/index.js';
import { createFakeSite, type FakeSite, type FakeSiteOptions } from './fake-site.js';
import { SITE_TEMPLATES } from './sites.js';

export interface AttachOptions {
  plugin: BrowserAIPlugin;
  site: FakeSite;
  logger?: Logger;
  now?: () => number;
  /** Extra plugin configuration handed over via `PluginContext.config`. */
  config?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Build the plugin context a plugin would get inside a real content script. */
export function contextForSite(options: AttachOptions): PluginContext {
  return {
    driver: options.site.driver,
    logger: options.logger ?? silentLogger,
    now: options.now ?? (() => Date.now()),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    config: options.config,
    signal: options.signal,
  };
}

export interface PageUnderTest {
  site: FakeSite;
  plugin: BrowserAIPlugin;
  adapter: AIAdapter;
  context: PluginContext;
  destroy(): void;
}

/** Instantiate `plugin` against the fake site — the full adapter, not a stub. */
export function attachPluginToSite(options: AttachOptions): PageUnderTest {
  const context = contextForSite(options);
  const adapter = options.plugin.createAdapter(context);
  return {
    site: options.site,
    plugin: options.plugin,
    adapter,
    context,
    destroy: () => options.site.destroy(),
  };
}

export interface SimulatedWorker {
  workerId: string;
  provider: string;
  manager: WorkerManager;
  registry: PluginRegistry;
  sites: FakeSite[];
  provider_: LocalSessionProvider;
  shutdown(): Promise<void>;
}

export interface SimulatedProvider {
  provider: LocalSessionProvider;
  sites: FakeSite[];
  destroy(): Promise<void>;
}

/**
 * Build a `LocalSessionProvider` whose pages are fake chat sites driven by the
 * real plugins — the runtime attaches it exactly like the extension bridge.
 */
export async function createSimulatedProvider(options: {
  registry: PluginRegistry;
  providers: string[];
  siteOptions?: Partial<Record<string, FakeSiteOptions>>;
  logger?: Logger;
  kind?: ExecutionLocation;
}): Promise<SimulatedProvider> {
  const logger = options.logger ?? createLogger({ level: 'warn', scope: 'simulator' });
  const requested = options.providers.includes('all')
    ? options.registry.list().map((descriptor) => descriptor.id)
    : options.providers;
  const sites: FakeSite[] = [];
  const provider = new LocalSessionProvider({ registry: options.registry, logger, kind: options.kind ?? 'simulator' });
  for (const providerId of requested) {
    const plugin = options.registry.get(providerId);
    if (!plugin) {
      logger.warn('cannot simulate unknown provider', { providerId });
      continue;
    }
    if (!SITE_TEMPLATES[providerId]) {
      logger.warn('no fake site available for provider', { providerId });
      continue;
    }
    const site = createFakeSite({ provider: providerId, ...(options.siteOptions?.[providerId] ?? {}) });
    sites.push(site);
    await provider.addSession({
      pluginId: providerId,
      url: site.url,
      title: `${plugin.name} (simulated)`,
      capabilities: plugin.capabilities(),
      driver: site.driver,
      domDriver: site.driver,
      close: () => {
        site.destroy();
      },
    });
  }
  return {
    provider,
    sites,
    destroy: async () => {
      await provider.disconnect();
      for (const site of sites) site.destroy();
    },
  };
}

export interface CreateSimulatedWorkersOptions {
  registry: PluginRegistry;
  /** Plugin ids to simulate, e.g. `['deepseek', 'chatgpt']` or `['all']`. */
  providers: string[];
  siteOptions?: Partial<Record<string, FakeSiteOptions>>;
  logger?: Logger;
  kind?: ExecutionLocation;
  /** Per-task timeout used by the worker manager. */
  timeoutMs?: number;
}

/**
 * Spin up one fake page per provider and register them as workers.
 * This is what `npm run demo` and `browsermind --simulate all` use.
 */
export async function createSimulatedWorkers(options: CreateSimulatedWorkersOptions): Promise<SimulatedWorker> {
  const logger = options.logger ?? createLogger({ level: 'warn', scope: 'simulator' });
  const simulated = await createSimulatedProvider({
    registry: options.registry,
    providers: options.providers,
    siteOptions: options.siteOptions,
    logger,
    kind: options.kind,
  });
  const manager = new WorkerManager({
    registry: options.registry,
    provider: simulated.provider,
    logger,
    defaultTimeoutMs: options.timeoutMs ?? 60_000,
  });
  await manager.start();
  const requested = options.providers.includes('all')
    ? options.registry.list().map((descriptor) => descriptor.id)
    : options.providers;

  return {
    workerId: manager.listWorkers()[0]?.id ?? '',
    provider: requested[0] ?? '',
    manager,
    registry: options.registry,
    sites: simulated.sites,
    provider_: simulated.provider,
    async shutdown() {
      await manager.stop();
      await simulated.destroy();
    },
  };
}

/** Build a declarative plugin straight from a selector pack (used by tests + plugin authoring REPL). */
export function pluginFromPack(manifest: PluginManifest, pack: SelectorPack): BrowserAIPlugin {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    match: (url) => matchAnyPattern(manifest.matchPatterns, url),
    capabilities: () => manifest.capabilities ?? ['chat'],
    createAdapter: (context) =>
      new SelectorAdapter(context, {
        pluginId: manifest.id,
        capabilities: manifest.capabilities ?? ['chat'],
        pack,
      }),
    describe: () => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      matchPatterns: manifest.matchPatterns,
      capabilities: manifest.capabilities ?? ['chat'],
      description: manifest.description,
    }),
  };
}

export type { PageSession, Logger };
