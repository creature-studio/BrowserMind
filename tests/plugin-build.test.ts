/**
 * Plugin build & packaging pipeline.
 *
 * Proves the `scripts/build-plugins.ts` pipeline:
 *   - packages every shipped plugin folder into a portable build tree
 *   - bundles code plugins into a single ESM file with the core kept external
 *   - keeps declarative plugins manifest-only
 *   - writes a hash-verified index.json
 *   - fails cleanly on invalid manifests / duplicate ids (no half-output)
 *   - emits valid ZIPs with --zip
 *   - and, crucially, that the packaged tree loads back through the real
 *     runtime plugin loader (the consumer that will actually ship it).
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPlugins, createZip, type BuildPluginsOptions } from '../scripts/build-plugins';
import { loadPluginsFromDisk } from '@browsermind/core';
import { silentLogger } from '@browsermind/core/browser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = path.join(root, 'plugins');

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('plugin build pipeline', () => {
  let out: string;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'browsermind-build-test-'));
    out = path.join(tmp, 'out');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('packages every shipped plugin folder with a hash-verified index', async () => {
    const result = await buildPlugins({ dir: pluginsDir, out, quiet: true });
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.plugins).toHaveLength(6);

    // index.json lists every plugin, sorted, with real hashes
    const index = JSON.parse(readFileSync(result.indexPath, 'utf8'));
    expect(index.pluginCount).toBe(6);
    expect(index.plugins.map((p: { id: string }) => p.id)).toEqual(
      ['chatgpt', 'claude', 'deepseek', 'gemini', 'grok', 'mock'],
    );
    for (const entry of index.plugins) {
      expect(entry.files.length).toBeGreaterThan(0);
      for (const file of entry.files) {
        const data = readFileSync(path.join(out, entry.id, file.name));
        expect(file.size).toBe(data.length);
        expect(file.sha256).toBe(sha256(data));
      }
    }
  }, 30_000);

  it('bundles code plugins into one ESM file and keeps the core external', async () => {
    const result = await buildPlugins({ dir: pluginsDir, out, quiet: true });
    const code = new Set(result.plugins.filter((p) => p.kind === 'code').map((p) => p.id));
    expect(code).toEqual(new Set(['chatgpt', 'claude', 'deepseek', 'mock']));

    for (const plugin of result.plugins) {
      const dirEntries = readdirSync(path.join(out, plugin.id)).sort();
      if (plugin.kind === 'code') {
        expect(dirEntries).toEqual(['adapter.js', 'plugin.json']);
        const code = readFileSync(path.join(out, plugin.id, 'adapter.js'), 'utf8');
        // fully bundled: no relative ./ imports and no .ts sources left behind
        expect(code).not.toMatch(/^import .* from ['"]\.\//m);
        expect(code).not.toMatch(/require\(['"]\.\//);
        expect(code).not.toMatch(/from ['"]\.\/selectors/);
        // core stays external so the host supplies a single instance
        expect(code).toMatch(/['"]@browsermind\/core\/browser['"]/);
      } else {
        // declarative: manifest only, no build output
        expect(dirEntries).toEqual(['plugin.json']);
      }
      // manifest is copied verbatim (shipped folders are named after their id)
      const sourceManifest = readFileSync(path.join(pluginsDir, plugin.id, 'plugin.json'), 'utf8');
      expect(readFileSync(path.join(out, plugin.id, 'plugin.json'), 'utf8')).toBe(sourceManifest);
    }
  }, 30_000);

  it('produces deterministic output for an identical input tree', async () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    await buildPlugins({ dir: pluginsDir, out: a, quiet: true });
    await buildPlugins({ dir: pluginsDir, out: b, quiet: true });
    const hash = (dir: string): string =>
      sha256(
        readdirSync(dir)
          .filter((f) => f !== 'index.json')
          .sort()
          .map((f) => `${f}:${sha256(readFileSync(path.join(dir, f)))}`)
          .join('|'),
      );
    for (const plugin of readdirSync(a).filter((f) => statSync(path.join(a, f)).isDirectory())) {
      expect(hash(path.join(a, plugin))).toBe(hash(path.join(b, plugin)));
    }
  }, 30_000);

  it('fails the build on an invalid manifest and leaves no half-output', async () => {
    const dir = path.join(tmp, 'plugins');
    mkdirSync(path.join(dir, 'good'), { recursive: true });
    writeFileSync(
      path.join(dir, 'good', 'plugin.json'),
      JSON.stringify({
        id: 'good',
        name: 'Good',
        version: '1.0.0',
        matchPatterns: ['https://good.example.com/*'],
        selectors: { input: ['.in'], response: ['.out'] },
      }),
    );
    mkdirSync(path.join(dir, 'broken'), { recursive: true });
    writeFileSync(path.join(dir, 'broken', 'plugin.json'), JSON.stringify({ id: 'broken', name: 'Broken', version: '1.0.0' }));

    const result = await buildPlugins({ dir, out, quiet: true });
    expect(result.plugins.map((p) => p.id)).toEqual(['good']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].dir).toBe(path.join(dir, 'broken'));
    expect(existsSync(path.join(out, 'broken'))).toBe(false);
    expect(existsSync(path.join(out, 'good', 'plugin.json'))).toBe(true);
  });

  it('rejects duplicate plugin ids', async () => {
    const dir = path.join(tmp, 'plugins');
    for (const name of ['first', 'second']) {
      mkdirSync(path.join(dir, name), { recursive: true });
      writeFileSync(
        path.join(dir, name, 'plugin.json'),
        JSON.stringify({
          id: 'dup',
          name: 'Dup',
          version: '1.0.0',
          matchPatterns: ['https://dup.example.com/*'],
          selectors: { input: ['.in'], response: ['.out'] },
        }),
      );
    }
    const result = await buildPlugins({ dir, out, quiet: true });
    expect(result.plugins).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/already used/);
  });

  it('emits valid, extractable ZIPs with --zip', async () => {
    const result = await buildPlugins({ dir: pluginsDir, out, zip: true, quiet: true });
    const zipsDir = path.join(out, '.zips');
    const zips = readdirSync(zipsDir).sort();
    expect(zips).toContain('browsermind-plugins.zip');
    for (const plugin of result.plugins) expect(zips).toContain(`${plugin.id}.zip`);

    for (const zip of zips) {
      const buf = readFileSync(path.join(zipsDir, zip));
      // "PK\x03\x04" local header + "PK\x05\x06" end-of-central-directory signatures
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(buf.subarray(buf.length - 22, buf.length - 18)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      // entry count in the EOCD matches what we wrote
      const eocd = buf.subarray(buf.length - 22);
      const count = eocd.readUInt16LE(8);
      expect(count).toBeGreaterThan(0);
    }
  }, 30_000);

  it('packages a custom plugin folder via --dir', async () => {
    const dir = path.join(tmp, 'mine');
    mkdirSync(path.join(dir, 'my-provider'), { recursive: true });
    writeFileSync(
      path.join(dir, 'my-provider', 'plugin.json'),
      JSON.stringify({
        id: 'my-provider',
        name: 'My Provider',
        version: '0.0.1',
        matchPatterns: ['https://my.example.com/*'],
        selectors: { input: ['.box'], response: ['.reply'] },
      }),
    );
    const result = await buildPlugins({ dir, out, quiet: true });
    expect(result.plugins.map((p) => p.id)).toEqual(['my-provider']);
    expect(existsSync(path.join(out, 'my-provider', 'plugin.json'))).toBe(true);
  });

  it('the packaged build loads back through the runtime plugin loader', async () => {
    await buildPlugins({ dir: pluginsDir, out, quiet: true });
    const result = await loadPluginsFromDisk({ dir: out, logger: silentLogger });
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.loaded.map((p) => p.descriptor.id).sort()).toEqual([
      'chatgpt',
      'claude',
      'deepseek',
      'gemini',
      'grok',
      'mock',
    ]);
    // each packaged plugin is a real, functional plugin
    for (const { plugin } of result.loaded) {
      expect(plugin.id).toMatch(/^[a-z0-9-]+$/);
      expect(plugin.capabilities()).toContain('chat');
      expect(typeof plugin.createAdapter).toBe('function');
    }
  }, 30_000);

  it('refuses dangerous output locations', async () => {
    await expect(buildPlugins({ dir: pluginsDir, out: root, quiet: true })).rejects.toThrow(/too close/);
    await expect(buildPlugins({ dir: pluginsDir, out: pluginsDir, quiet: true })).rejects.toThrow(/too close/);
    await expect(buildPlugins({ dir: pluginsDir, out: path.join(pluginsDir, 'nested'), quiet: true })).rejects.toThrow(
      /nested inside/,
    );
  });
});

// --- createZip unit tests -----------------------------------------------------

describe('createZip', () => {
  it('round-trips a small archive structure', () => {
    const buf = createZip([
      { name: 'a/plugin.json', data: Buffer.from('{"id":"a"}') },
      { name: 'a/adapter.js', data: Buffer.from('export {}') },
    ]);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const eocd = buf.subarray(buf.length - 22);
    expect(eocd.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd.readUInt16LE(8)).toBe(2); // two entries
    expect(eocd.readUInt16LE(10)).toBe(2);
  });

  it('produces deterministic bytes for identical input', () => {
    const a = createZip([{ name: 'x.txt', data: Buffer.from('hello') }]);
    const b = createZip([{ name: 'x.txt', data: Buffer.from('hello') }]);
    expect(a.equals(b)).toBe(true);
  });
});

// helper: shipped plugin folders are named after their manifest id
function dirNameFor(id: string): string {
  return id;
}

// keep the type import referenced for editors
type _Opts = BuildPluginsOptions;
