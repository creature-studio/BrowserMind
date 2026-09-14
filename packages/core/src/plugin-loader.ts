/**
 * Plugin loader (Node side).
 *
 * A plugin is a folder:
 *
 *   plugins/deepseek/
 *     plugin.json     ← manifest (id, name, version, matchPatterns…)
 *     adapter.ts      ← optional: exports the `BrowserAIPlugin` (or a factory)
 *     selectors.ts    ← optional: selector pack used by the adapter
 *
 * The loader only needs `plugin.json`. If the folder ships code, that code is
 * used; if it only ships selectors, a declarative plugin is created on the fly.
 * Either way the runtime never changes.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginRegistry } from './registry.js';
import { createDeclarativePlugin, validateManifest, type PluginManifest } from './plugins/declarative.js';
import { createLogger, silentLogger } from './logger.js';
import { ValidationError } from './errors.js';
import type { BrowserAIPlugin, Logger, PluginDescriptor } from './types.js';

export interface LoadedPlugin {
  descriptor: PluginDescriptor;
  plugin: BrowserAIPlugin;
  dir: string;
}

export interface LoadPluginsOptions {
  dir?: string;
  registry?: PluginRegistry;
  logger?: Logger;
  /** Only load these plugin ids when provided. */
  include?: string[];
  /** Extra source for `import()` — injectable for tests. */
  importer?: (specifier: string) => Promise<unknown>;
}

export interface LoadPluginsResult {
  registry: PluginRegistry;
  loaded: LoadedPlugin[];
  failed: Array<{ dir: string; error: string }>;
}

const ADAPTER_FILE_CANDIDATES = ['adapter.ts', 'adapter.js', 'adapter.mts', 'adapter.mjs', 'index.ts', 'index.js'];

export function defaultPluginDir(cwd = process.cwd()): string {
  const env = process.env.BROWSERMIND_PLUGIN_DIR;
  if (env) return path.resolve(env);
  const candidates = [
    path.resolve(cwd, 'plugins'),
    path.resolve(cwd, '..', 'plugins'),
    path.resolve(cwd, '..', '..', 'plugins'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export async function readManifest(dir: string, options: { requireSelectors?: boolean } = {}): Promise<PluginManifest> {
  const manifestPath = path.join(dir, 'plugin.json');
  const raw = await readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`${manifestPath} is not valid JSON: ${(error as Error).message}`);
  }
  return validateManifest(parsed, options);
}

export async function loadPluginDir(
  dir: string,
  options: { logger?: Logger; importer?: (specifier: string) => Promise<unknown> } = {},
): Promise<BrowserAIPlugin> {
  const log = options.logger ?? silentLogger;
  // A code-based plugin keeps its selector pack in `selectors.ts`, so the
  // manifest only has to declare the metadata until we know which style it is.
  const manifest = await readManifest(dir, { requireSelectors: false });
  const importer = options.importer ?? ((specifier: string) => import(specifier));

  let moduleFile: string | null = null;
  for (const candidate of ADAPTER_FILE_CANDIDATES) {
    const full = path.join(dir, candidate);
    if (existsSync(full)) {
      moduleFile = full;
      break;
    }
  }

  if (moduleFile) {
    const url = pathToFileURL(moduleFile).href;
    const module = (await importer(url)) as Record<string, unknown>;
    const exported =
      (module.default as BrowserAIPlugin | undefined) ??
      (module.plugin as BrowserAIPlugin | undefined) ??
      (module.adapterPlugin as BrowserAIPlugin | undefined) ??
      (typeof module.createPlugin === 'function' ? (module.createPlugin as () => BrowserAIPlugin)() : undefined) ??
      (module.manifest as PluginManifest | undefined);
    if (exported && typeof (exported as BrowserAIPlugin).createAdapter === 'function') {
      const plugin = exported as BrowserAIPlugin;
      if (plugin.id !== manifest.id) {
        log.warn('plugin id mismatch between plugin.json and the adapter module', {
          dir,
          manifestId: manifest.id,
          pluginId: plugin.id,
        });
      }
      return plugin;
    }
    if (exported) {
      return createDeclarativePlugin({ ...manifest, ...(exported as PluginManifest) });
    }
    log.warn('plugin module exported nothing usable; falling back to the declarative manifest', { dir });
  }

  if (!manifest.selectors) {
    throw new ValidationError(
      `Plugin "${manifest.id}" in ${dir} has neither an adapter module nor a "selectors" section in plugin.json`,
    );
  }
  return createDeclarativePlugin(manifest);
}

/** Discover and register every plugin folder found under `dir`. */
export async function loadPluginsFromDisk(options: LoadPluginsOptions = {}): Promise<LoadPluginsResult> {
  const dir = options.dir ?? defaultPluginDir();
  const logger = options.logger ?? createLogger({ scope: 'plugins' });
  const registry = options.registry ?? new PluginRegistry();
  const loaded: LoadedPlugin[] = [];
  const failed: Array<{ dir: string; error: string }> = [];

  if (!existsSync(dir)) {
    logger.warn('plugin directory does not exist', { dir });
    return { registry, loaded, failed };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    if (options.include?.length && !options.include.includes(entry.name)) continue;
    try {
      const plugin = await loadPluginDir(pluginDir, { logger, importer: options.importer });
      registry.register(plugin);
      loaded.push({ descriptor: plugin.describe(), plugin, dir: pluginDir });
      logger.info('plugin loaded', { id: plugin.id, version: plugin.version, dir: pluginDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ dir: pluginDir, error: message });
      logger.error('plugin failed to load', { dir: pluginDir, error: message });
    }
  }

  return { registry, loaded, failed };
}

export async function listPluginDirs(dir = defaultPluginDir()): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await stat(path.join(dir, entry.name)).catch(() => null);
    if (info?.isDirectory() && existsSync(path.join(dir, entry.name, 'plugin.json'))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}
