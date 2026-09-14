/**
 * Headless simulator.
 *
 * Gives the runtime real pages to drive without a browser: each requested
 * provider gets a jsdom fake chat site (see `@browsermind/testing`) and the
 * *real* plugin adapter runs against it. `jsdom` is imported lazily so a
 * production runtime never pays for it.
 */
import type { SessionProvider } from '@browsermind/core';
import type { Logger, PluginRegistry } from '@browsermind/core';

export interface SimulatorOptions {
  registry: PluginRegistry;
  providers: string[];
  logger: Logger;
}

export interface SimulatorHandle {
  provider: SessionProvider;
  providers: string[];
  destroy(): Promise<void>;
}

export async function createSimulatorProvider(options: SimulatorOptions): Promise<SimulatorHandle> {
  const testing = await import('@browsermind/testing');
  const simulated = await testing.createSimulatedProvider({
    registry: options.registry,
    providers: options.providers,
    logger: options.logger,
    kind: 'simulator',
  });
  const available = options.registry
    .list()
    .map((descriptor) => descriptor.id)
    .filter((id) => Boolean(testing.SITE_TEMPLATES[id]));
  options.logger.info('simulator ready', { providers: available, requested: options.providers });
  return {
    provider: simulated.provider,
    providers: available,
    destroy: simulated.destroy,
  };
}
