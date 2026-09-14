/**
 * Every shipped plugin is driven against its fake site.
 *
 * These tests are the contract of a plugin folder: if a provider's markup
 * changes, the corresponding `selectors.ts` + fixture pair is what gets fixed —
 * core code is never touched.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPluginsFromDisk } from '../packages/core/src/plugin-loader.js';
import type { PluginRegistry } from '../packages/core/src/registry.js';
import { createFakeSite, type FakeSite } from '../packages/testing/src/fake-site.js';
import { createDeclarativePlugin } from '../packages/core/src/plugins/declarative.js';
import { attachPluginToSite } from '../packages/testing/src/harness.js';
import { PageUnavailableError } from '../packages/core/src/errors.js';

const PROVIDERS = ['mock', 'deepseek', 'chatgpt', 'claude', 'gemini', 'grok'];

let registry: PluginRegistry;
const sites: FakeSite[] = [];

beforeAll(async () => {
  const loaded = await loadPluginsFromDisk();
  registry = loaded.registry;
  expect(loaded.failed).toEqual([]);
});

function withSite(provider: string, options: { chunkDelayMs?: number } = {}) {
  const site = createFakeSite({ provider, chunkDelayMs: options.chunkDelayMs ?? 4, firstChunkDelayMs: 4 });
  sites.push(site);
  const plugin = registry.get(provider);
  if (!plugin) throw new Error(`plugin ${provider} not loaded`);
  return attachPluginToSite({ plugin, site });
}

describe('plugin folders', () => {
  it('loads all six providers, including the two declarative ones', async () => {
    const descriptors = registry.list();
    expect(descriptors.map((descriptor) => descriptor.id).sort()).toEqual([...PROVIDERS].sort());
    expect(descriptors.find((descriptor) => descriptor.id === 'gemini')?.source).toBe('declarative');
    expect(descriptors.find((descriptor) => descriptor.id === 'deepseek')?.source).toBe('builtin');
  });

  for (const provider of PROVIDERS) {
    describe(`${provider} plugin`, () => {
      it('types, submits and reads back the streamed answer', async () => {
        const { site, adapter, destroy } = withSite(provider);
        const progress: string[] = [];

        expect(await adapter.getStatus()).toBe('ready');
        await adapter.sendMessage('Analyse this project');
        const response = await adapter.waitForResponse({
          timeoutMs: 20_000,
          onProgress: (text) => progress.push(text),
        });

        expect(site.submissions).toEqual(['Analyse this project']);
        expect(response).toContain('complete reply');
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(progress[progress.length - 1]).toBe(response);
        expect(await adapter.getStatus()).toBe('ready');
        destroy();
      });

      it('reports a provider-agnostic snapshot', async () => {
        const { adapter, destroy } = withSite(provider);
        const snapshot = await adapter.snapshot();
        expect(snapshot.provider).toBe(provider);
        expect(snapshot.url).toMatch(/^https:\/\//);
        expect(snapshot.status).toBe('ready');
        expect(snapshot.capabilities).toContain('chat');
        expect(snapshot.availableActions.map((action) => action.id)).toContain('chat');
        // No DOM/selector leakage: the agent must never learn how the page works.
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toMatch(/querySelector|#prompt-input|ds-markdown|<div/);
        destroy();
      });

      it('stops generation on request', async () => {
        const { site, adapter, destroy } = withSite(provider);
        await adapter.sendMessage('long answer please');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(adapter.stop, `${provider} must expose stop()`).toBeTypeOf('function');
        await adapter.stop!();
        expect(site.isGenerating()).toBe(false);
        destroy();
      });

      it('uploads files through the page UI', async () => {
        const { site, adapter, destroy } = withSite(provider);
        await adapter.sendMessage('look at this', {
          files: [{ name: 'notes.md', text: '# notes' }],
        });
        expect(site.uploads).toEqual(['notes.md']);
        await adapter.waitForResponse({ timeoutMs: 20_000 });
        destroy();
      });
    });
  }

  it('reports blocked pages instead of pretending to work', async () => {
    const site = createFakeSite({ provider: 'deepseek', loginRequired: true, chunkDelayMs: 4 });
    const plugin = registry.get('deepseek')!;
    const { adapter } = attachPluginToSite({ plugin, site });
    expect(await adapter.getStatus()).toBe('blocked');
    await expect(adapter.sendMessage('hello')).rejects.toBeInstanceOf(PageUnavailableError);
    const snapshot = await adapter.snapshot();
    expect(snapshot.state).toBe('login-required');
    site.destroy();
  });

  it('returns partial answers when a provider stalls', async () => {
    const site = createFakeSite({ provider: 'chatgpt', stallAfterChunks: 3, chunkDelayMs: 4 });
    const plugin = registry.get('chatgpt')!;
    const { adapter } = attachPluginToSite({ plugin, site });
    await adapter.sendMessage('stall please');
    const text = await adapter.waitForResponse({ timeoutMs: 600, partial: true });
    expect(text.length).toBeGreaterThan(0);
    site.destroy();
  });

  it('fails loudly when the composer disappears', async () => {
    const site = createFakeSite({ provider: 'gemini', chunkDelayMs: 4 });
    site.removeComposer();
    const plugin = registry.get('gemini')!;
    const { adapter } = attachPluginToSite({ plugin, site });
    await expect(adapter.sendMessage('hello')).rejects.toBeInstanceOf(PageUnavailableError);
    expect(await adapter.getStatus()).toBe('waiting');
    site.destroy();
  });

  it('reports intermediate streaming states for a slow provider', async () => {
    const { adapter, destroy } = withSite('deepseek', { chunkDelayMs: 70 });
    const progress: string[] = [];
    await adapter.sendMessage('stream slowly');
    const response = await adapter.waitForResponse({ timeoutMs: 30_000, onProgress: (text) => progress.push(text) });
    expect(progress.length).toBeGreaterThan(1);
    expect(response).toContain('complete reply');
    destroy();
  });

  it('survives a broken selector candidate', async () => {
    // A real site changes its markup constantly: one dead candidate must not
    // take the plugin down.
    const site = createFakeSite({ provider: 'mock', chunkDelayMs: 4 });
    const plugin = createDeclarativePlugin({
      id: 'broken-candidates',
      name: 'Broken candidates',
      version: '1.0.0',
      matchPatterns: ['https://mock.browsermind.local/*'],
      capabilities: ['chat'],
      selectors: {
        input: ['#prompt-input'],
        response: ['.message.assistant .mock-markdown'],
        // Invalid CSS and a stale id: both must be skipped, not fatal.
        blocked: [':::', '#does-not-exist'],
      },
    });
    const { adapter } = attachPluginToSite({ plugin, site });
    expect(await adapter.getStatus()).toBe('ready');
    await adapter.sendMessage('still works');
    expect(await adapter.waitForResponse({ timeoutMs: 20_000 })).toContain('complete reply');
    site.destroy();
  });
});
