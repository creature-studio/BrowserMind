/**
 * Plugin registry.
 *
 * The registry is the *only* place where "which provider handles this URL"
 * is decided. There is deliberately no `if (provider === 'deepseek')` anywhere
 * in the code base — adding a provider means adding a plugin folder.
 */
import { matchAnyPattern, patternSpecificity } from './match-pattern.js';
import { ValidationError } from './errors.js';
import type { BrowserAIPlugin, PluginDescriptor, PluginId, PluginSourceKind } from './types.js';

export interface PluginMetadata {
  source?: PluginSourceKind;
  installedAt?: number;
  enabled?: boolean;
  accent?: string;
  description?: string;
}

export interface RegistryEntry {
  plugin: BrowserAIPlugin;
  patterns: string[];
  descriptor: PluginDescriptor;
  source: PluginSourceKind;
}

export function definePlugin<const T extends BrowserAIPlugin>(plugin: T): T {
  return plugin;
}

/** Creates a plugin object from a declarative manifest + an adapter factory. */
export function createPlugin(spec: {
  id: PluginId;
  name: string;
  version: string;
  matchPatterns: string[];
  capabilities?: string[];
  description?: string;
  homepage?: string;
  accent?: string;
  metadata?: PluginMetadata;
  createAdapter: BrowserAIPlugin['createAdapter'];
}): BrowserAIPlugin {
  const plugin: BrowserAIPlugin = {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    match: (url) => matchAnyPattern(spec.matchPatterns, url),
    capabilities: () => spec.capabilities ?? ['chat'],
    createAdapter: spec.createAdapter,
    describe: () => ({
      id: spec.id,
      name: spec.name,
      version: spec.version,
      matchPatterns: spec.matchPatterns,
      capabilities: spec.capabilities ?? ['chat'],
      description: spec.description,
      homepage: spec.homepage,
      accent: spec.accent,
      source: spec.metadata?.source ?? 'builtin',
      installedAt: spec.metadata?.installedAt,
      enabled: spec.metadata?.enabled ?? true,
    }),
  };
  return plugin;
}

export class PluginRegistry {
  #entries = new Map<PluginId, RegistryEntry>();

  /** Register a plugin. Later registrations with the same id replace earlier ones. */
  register(plugin: BrowserAIPlugin, metadata: PluginMetadata = {}): this {
    if (!plugin?.id) throw new ValidationError('Plugin is missing an id');
    if (!plugin.match || typeof plugin.match !== 'function') {
      throw new ValidationError(`Plugin "${plugin.id}" does not implement match(url)`);
    }
    if (typeof plugin.createAdapter !== 'function') {
      throw new ValidationError(`Plugin "${plugin.id}" does not implement createAdapter(context)`);
    }
    const descriptor: PluginDescriptor = {
      ...plugin.describe(),
      source: metadata.source ?? plugin.describe().source ?? 'builtin',
      installedAt: metadata.installedAt ?? plugin.describe().installedAt,
      enabled: metadata.enabled ?? plugin.describe().enabled ?? true,
      accent: metadata.accent ?? plugin.describe().accent,
      description: metadata.description ?? plugin.describe().description,
    };
    this.#entries.set(plugin.id, {
      plugin,
      patterns: descriptor.matchPatterns,
      descriptor,
      source: descriptor.source ?? 'builtin',
    });
    return this;
  }

  unregister(id: PluginId): boolean {
    return this.#entries.delete(id);
  }

  setEnabled(id: PluginId, enabled: boolean): void {
    const entry = this.#entries.get(id);
    if (entry) entry.descriptor.enabled = enabled;
  }

  has(id: PluginId): boolean {
    return this.#entries.has(id);
  }

  get(id: PluginId): BrowserAIPlugin | undefined {
    const entry = this.#entries.get(id);
    return entry?.descriptor.enabled === false ? undefined : entry?.plugin;
  }

  getEntry(id: PluginId): RegistryEntry | undefined {
    return this.#entries.get(id);
  }

  list(): PluginDescriptor[] {
    return [...this.#entries.values()]
      .map((entry) => ({ ...entry.descriptor }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** All plugins, including disabled ones (used by the dashboard). */
  entries(): RegistryEntry[] {
    return [...this.#entries.values()];
  }

  /**
   * Find the plugin that handles `url`.
   * Hosts are matched by pattern specificity first, then by registration order,
   * so a plugin for `chat.example.com` wins over a `*.example.com` wildcard.
   */
  findPlugin(url: string): BrowserAIPlugin | null {
    const matches: { entry: RegistryEntry; score: number }[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.descriptor.enabled === false) continue;
      let matched = false;
      try {
        matched = entry.plugin.match(url);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      const score = Math.max(...entry.patterns.map(patternSpecificity), 0);
      matches.push({ entry, score });
    }
    if (!matches.length) return null;
    matches.sort((a, b) => b.score - a.score);
    return matches[0]!.entry.plugin;
  }

  /** Find by id (preferred) or, failing that, by URL. */
  resolve(ref: { provider?: PluginId; url?: string }): BrowserAIPlugin | null {
    if (ref.provider) {
      const byId = this.get(ref.provider);
      if (byId) return byId;
    }
    if (ref.url) return this.findPlugin(ref.url);
    return null;
  }

  createAdapter(ref: { provider?: PluginId; url?: string }, context: Parameters<BrowserAIPlugin['createAdapter']>[0]) {
    const plugin = this.resolve(ref);
    if (!plugin) {
      throw new ValidationError(`No plugin available for ${ref.provider ?? ref.url ?? 'unknown target'}`, {
        provider: ref.provider,
        url: ref.url,
        registered: this.list().map((entry) => entry.id),
      });
    }
    return { plugin, adapter: plugin.createAdapter(context) };
  }

  /** Match patterns of every enabled plugin — used to request extension host permissions. */
  allMatchPatterns(): string[] {
    const patterns = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.descriptor.enabled === false) continue;
      for (const pattern of entry.patterns) patterns.add(pattern);
    }
    return [...patterns];
  }

  /** Suggest a stable worker/plugin id for a URL: `chat.deepseek.com` → not needed, plugin id wins. */
  providerForUrl(url: string): PluginId | null {
    return this.findPlugin(url)?.id ?? null;
  }
}

/** Default global registry. Extensions, runtime and tests may also build their own. */
export const globalRegistry = new PluginRegistry();
