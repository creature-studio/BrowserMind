import { describe, expect, it } from 'vitest';
import { PluginRegistry, createPlugin } from '../packages/core/src/registry.js';
import { createDeclarativePlugin } from '../packages/core/src/plugins/declarative.js';
import type { SelectorPack } from '../packages/core/src/adapter/selectors.js';

const pack: SelectorPack = { input: ['#input'], response: ['.answer'] };

function plugin(id: string, patterns: string[]) {
  return createPlugin({
    id,
    name: id,
    version: '1.0.0',
    matchPatterns: patterns,
    capabilities: ['chat'],
    createAdapter: () => {
      throw new Error('not used');
    },
  });
}

describe('plugin registry', () => {
  it('resolves a URL to a plugin without any provider branching in core', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('deepseek', ['https://chat.deepseek.com/*']));
    registry.register(plugin('chatgpt', ['https://chatgpt.com/*', 'https://chat.openai.com/*']));

    expect(registry.findPlugin('https://chat.deepseek.com/a/chat/s/123')?.id).toBe('deepseek');
    expect(registry.findPlugin('https://chatgpt.com/c/abc')?.id).toBe('chatgpt');
    expect(registry.findPlugin('https://chat.openai.com/')?.id).toBe('chatgpt');
    expect(registry.findPlugin('https://example.com/')).toBeNull();
  });

  it('prefers the more specific plugin when two match', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('all-sites', ['https://*/*']));
    registry.register(plugin('exact', ['https://chat.example.com/*']));
    expect(registry.findPlugin('https://chat.example.com/x')?.id).toBe('exact');
  });

  it('supports install / enable / uninstall at runtime', () => {
    const registry = new PluginRegistry();
    registry.register(createDeclarativePlugin({ id: 'acme', name: 'ACME', version: '1.0.0', matchPatterns: ['https://acme.ai/*'], selectors: pack }));
    expect(registry.has('acme')).toBe(true);
    expect(registry.list().map((descriptor) => descriptor.id)).toEqual(['acme']);

    registry.setEnabled('acme', false);
    expect(registry.findPlugin('https://acme.ai/')).toBeNull();
    registry.setEnabled('acme', true);
    expect(registry.findPlugin('https://acme.ai/')).not.toBeNull();

    expect(registry.unregister('acme')).toBe(true);
    expect(registry.findPlugin('https://acme.ai/')).toBeNull();
  });

  it('validates plugins at registration time', () => {
    const registry = new PluginRegistry();
    expect(() => registry.register({ id: '', name: 'x', version: '1', match: () => true, capabilities: () => [], createAdapter: (() => ({})) as never, describe: (() => ({})) as never })).toThrow();
    expect(() =>
      registry.register({
        id: 'broken',
        name: 'Broken',
        version: '1.0.0',
        match: () => true,
        capabilities: () => ['chat'],
        createAdapter: undefined as never,
        describe: () => ({ id: 'broken', name: 'Broken', version: '1.0.0', matchPatterns: [], capabilities: [] }),
      }),
    ).toThrow(/createAdapter/);
  });

  it('rejects manifests that make no sense', () => {
    expect(() => createDeclarativePlugin({ id: 'x', name: 'x', version: '1', matchPatterns: ['nope'], selectors: pack })).toThrow();
    expect(() =>
      createDeclarativePlugin({ id: 'x', name: 'x', version: '1', matchPatterns: ['https://x.ai/*'], selectors: { input: [] } }),
    ).toThrow(/input selector/i);
    expect(() =>
      createDeclarativePlugin({
        id: 'x',
        name: 'x',
        version: '1',
        matchPatterns: ['https://x.ai/*'],
        selectors: { input: ['   '], response: ['.answer'] },
      }),
    ).toThrow(/empty selector/i);
  });
});
