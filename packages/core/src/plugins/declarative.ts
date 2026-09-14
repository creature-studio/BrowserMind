/**
 * Declarative plugins.
 *
 * Phase 4 of the roadmap: a provider plugin is nothing but a manifest plus a
 * selector pack. Such a plugin can be shipped as a JSON file, installed at
 * runtime, and needs no build step, no npm publish and — crucially — no change
 * to the core:
 *
 * ```json
 * {
 *   "id": "gemini",
 *   "name": "Gemini Web",
 *   "version": "1.0.0",
 *   "matchPatterns": ["https://gemini.google.com/*"],
 *   "capabilities": ["chat", "image_input"],
 *   "selectors": { "input": ["rich-textarea .ql-editor"], "response": ["model-response .markdown"] }
 * }
 * ```
 */
import { createPlugin } from '../registry.js';
import { SelectorAdapter } from '../adapter/selector-adapter.js';
import { validatePack, type SelectorPack } from '../adapter/selectors.js';
import { ValidationError } from '../errors.js';
import { isValidPattern } from '../match-pattern.js';
import type { BrowserAIPlugin, PluginContext, PluginDescriptor, PluginManifest } from '../types.js';

export type { PluginManifest };

const REQUIRED_FIELDS: Array<keyof PluginManifest> = ['id', 'name', 'version', 'matchPatterns'];

export function validateManifest(input: unknown, options: { requireSelectors?: boolean } = {}): PluginManifest {
  if (!input || typeof input !== 'object') throw new ValidationError('Plugin manifest must be an object');
  const manifest = input as PluginManifest;
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] == null) throw new ValidationError(`Plugin manifest is missing "${field}"`);
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(manifest.id)) {
    throw new ValidationError(`Plugin id "${manifest.id}" must be alphanumeric (dashes allowed)`);
  }
  if (!Array.isArray(manifest.matchPatterns) || manifest.matchPatterns.length === 0) {
    throw new ValidationError('Plugin manifest must declare at least one match pattern');
  }
  for (const pattern of manifest.matchPatterns) {
    if (!isValidPattern(pattern)) throw new ValidationError(`Invalid match pattern "${pattern}"`);
  }
  if ((options.requireSelectors ?? true) && (!manifest.selectors || typeof manifest.selectors !== 'object')) {
    throw new ValidationError('Plugin manifest must declare a "selectors" object (or ship an adapter module)');
  }
  return manifest;
}

/** Build a runnable plugin out of a manifest — no code execution involved. */
export function createDeclarativePlugin(rawManifest: PluginManifest, descriptorExtras: Partial<PluginDescriptor> = {}): BrowserAIPlugin {
  const manifest = validateManifest(rawManifest, { requireSelectors: true });
  // Fail at install time rather than on the first page the plugin sees.
  validatePack(manifest.selectors!);
  const plugin = createPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    matchPatterns: manifest.matchPatterns,
    capabilities: manifest.capabilities ?? ['chat'],
    description: manifest.description,
    homepage: manifest.homepage,
    accent: manifest.accent,
    metadata: { source: 'declarative', installedAt: Date.now(), enabled: true },
    createAdapter: (context: PluginContext) =>
      new SelectorAdapter(context, {
        pluginId: manifest.id,
        capabilities: manifest.capabilities ?? ['chat'],
        pack: manifest.selectors!,
        states: manifest.states as never,
      }),
  });
  // The manifest travels with the plugin so the runtime can forward it to the
  // extension, which registers a matching content script for it.
  return Object.assign(plugin, { manifest }) as BrowserAIPlugin;
}

/** Convenience for `PluginRegistry.registerThirdParty(manifest)`. */
export function pluginFromManifestJson(json: string): BrowserAIPlugin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ValidationError(`Plugin manifest is not valid JSON: ${(error as Error).message}`);
  }
  const payload = (parsed as { plugin?: PluginManifest }).plugin ?? (parsed as PluginManifest);
  return createDeclarativePlugin(payload);
}
