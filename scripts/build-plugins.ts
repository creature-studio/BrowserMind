#!/usr/bin/env tsx
/**
 * Plugin build & packaging pipeline.
 *
 * Plugin folders are the single source of truth (`plugins/<id>/plugin.json`
 * ± adapter code). This script turns them into a portable, versioned build:
 *
 *   build/plugins/
 *     index.json            ← build manifest: id, version, kind, per-file sha256
 *     <id>/
 *       plugin.json         ← copy of the manifest (validated up front)
 *       adapter.js          ← code plugins only: esbuild bundle of adapter.ts
 *                              (+ its local imports, e.g. selectors.ts)
 *     .zips/                ← with `--zip`: one zip per plugin + one combined zip
 *
 * Rules the pipeline enforces:
 *   - every manifest passes the same `validateManifest` the registry uses,
 *     so a broken plugin fails the build instead of the first page it touches;
 *   - two folders may not claim the same plugin id;
 *   - bundled adapters keep `@browsermind/*` imports **external**: the host
 *     (runtime, extension build) supplies one core instance, so `instanceof`
 *     checks (timeouts, typed errors) keep working across the boundary;
 *   - output is deterministic (no timestamps in the bundle; zips use a fixed
 *     DOS date), so a CI rebuild of the same tree yields identical artifacts.
 *
 * Usage:
 *   npm run plugins:build               # build/plugins from ./plugins
 *   npm run plugins:build:zip           # same + .zips/ for distribution
 *   npx tsx scripts/build-plugins.ts --dir ./my-plugins --out ./dist/plugins
 *
 * Wired into `npm run verify`; CI (`.github/workflows/ci.yml`) runs the same
 * pipeline on every push/PR and uploads the packaged plugins + the extension
 * zip on pushes to main.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { validateManifest, type PluginManifest } from '@browsermind/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same discovery order the runtime loader uses (packages/core/src/plugin-loader.ts). */
const ADAPTER_CANDIDATES = ['adapter.ts', 'adapter.js', 'adapter.mts', 'adapter.mjs', 'index.ts', 'index.js'];

export interface BuildPluginsOptions {
  /** Folder containing one subdirectory per plugin. Default: `<repo>/plugins`. */
  dir?: string;
  /** Output folder (wiped first). Default: `<repo>/build/plugins`. */
  out?: string;
  /** Also write `.zips/<id>.zip` per plugin + `.zips/browsermind-plugins.zip` for all. */
  zip?: boolean;
  minify?: boolean;
  sourcemap?: boolean;
  quiet?: boolean;
}

export interface BuiltFile {
  name: string;
  size: number;
  sha256: string;
}

export interface BuiltPlugin {
  id: string;
  name: string;
  version: string;
  kind: 'code' | 'declarative';
  /** Source entry bundled, for code plugins. */
  entry?: string;
  matchPatterns: string[];
  capabilities: string[];
  files: BuiltFile[];
  /** Absolute path of the packaged plugin folder. */
  outDir: string;
}

export interface BuildPluginsResult {
  outDir: string;
  indexPath: string;
  plugins: BuiltPlugin[];
  failed: Array<{ dir: string; error: string }>;
  zips?: string[];
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Minimal dependency-free ZIP writer (store method, fixed date → deterministic)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a (uncompressed) ZIP archive. Fixed 1980-01-01 timestamps keep output stable. */
export function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const DOS_TIME = 0x0000;
  const DOS_DATE = 0x0021; // 1980-01-01
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, entry.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface DiscoveredPlugin {
  dir: string;
  dirName: string;
  manifestPath: string;
  /** null → plugin.json was not valid JSON (reported as a build failure). */
  manifest: PluginManifest | null;
  manifestText: string;
  entry: string | null;
}

async function discoverPlugins(dir: string): Promise<DiscoveredPlugin[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const found: DiscoveredPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(dir, entry.name);
    const manifestPath = path.join(dirPath, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    const manifestText = await readFile(manifestPath, 'utf8');
    let manifest: PluginManifest | null = null;
    try {
      manifest = JSON.parse(manifestText) as PluginManifest;
    } catch {
      manifest = null;
    }
    const adapter = ADAPTER_CANDIDATES.map((candidate) => path.join(dirPath, candidate)).find((file) =>
      existsSync(file),
    );
    found.push({ dir: dirPath, dirName: entry.name, manifestPath, manifest, manifestText, entry: adapter ?? null });
  }
  return found;
}

async function bundleAdapter(entry: string, outfile: string, options: { minify?: boolean; sourcemap?: boolean }): Promise<void> {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
    minify: options.minify ?? false,
    sourcemap: options.sourcemap ?? false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        // Keep the workspace core external: the host provides one core instance.
        name: 'external-browsermind-packages',
        setup(build) {
          build.onResolve({ filter: /^@browsermind\// }, (args) => ({ path: args.path, external: true }));
        },
      },
    ],
  });
}

export async function buildPlugins(options: BuildPluginsOptions = {}): Promise<BuildPluginsResult> {
  const dir = path.resolve(options.dir ?? path.join(root, 'plugins'));
  const out = path.resolve(options.out ?? path.join(root, 'build', 'plugins'));
  const log = (message: string) => {
    if (!options.quiet) console.log(message);
  };

  // Safety: the output dir is wiped — never allow it to be (or swallow) the source tree.
  for (const protectedDir of [root, dir]) {
    if (out === protectedDir || out === path.parse(protectedDir).root) {
      throw new Error(`refusing to use "${out}" as build output (too close to the source tree)`);
    }
  }
  if (out === dir || out.startsWith(dir + path.sep) || dir.startsWith(out + path.sep)) {
    throw new Error(`build output "${out}" must not be the plugin dir "${dir}" or nested inside it`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const discovered = await discoverPlugins(dir);
  const plugins: BuiltPlugin[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  const seenIds = new Map<string, string>();

  for (const candidate of discovered) {
    try {
      if (!candidate.manifest) {
        throw new Error('plugin.json is not valid JSON');
      }
      // Same validation the registry applies — fail the build, not the first page.
      const manifest = validateManifest(candidate.manifest, { requireSelectors: false });

      const collision = seenIds.get(manifest.id);
      if (collision) {
        throw new Error(`plugin id "${manifest.id}" is already used by ${path.relative(dir, collision)}`);
      }
      seenIds.set(manifest.id, candidate.dir);

      const pluginOutDir = path.join(out, manifest.id);
      await mkdir(pluginOutDir, { recursive: true });
      const files: BuiltFile[] = [];

      // 1. Manifest — copied verbatim so the packaged file matches the source.
      const manifestText = candidate.manifestText;
      await writeFile(path.join(pluginOutDir, 'plugin.json'), manifestText, 'utf8');
      files.push({ name: 'plugin.json', size: Buffer.byteLength(manifestText), sha256: sha256(manifestText) });

      // 2. Adapter — bundle code plugins into one ESM file; declarative stay JSON-only.
      let kind: 'code' | 'declarative' = 'declarative';
      let entryName: string | undefined;
      if (candidate.entry) {
        kind = 'code';
        entryName = path.basename(candidate.entry);
        const outfile = path.join(pluginOutDir, 'adapter.js');
        await bundleAdapter(candidate.entry, outfile, options);
        const data = await readFile(outfile);
        files.push({ name: 'adapter.js', size: data.length, sha256: sha256(data) });
        if (options.sourcemap) {
          const map = await readFile(outfile + '.map');
          files.push({ name: 'adapter.js.map', size: map.length, sha256: sha256(map) });
        }
      }

      files.sort((a, b) => a.name.localeCompare(b.name));
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        kind,
        entry: entryName,
        matchPatterns: manifest.matchPatterns ?? [],
        capabilities: manifest.capabilities ?? [],
        files,
        outDir: pluginOutDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ dir: candidate.dir, error: message });
      log(`  ${candidate.dirName.padEnd(12)} FAILED     ${message}`);
      // Drop the half-written output so a failing build never ships half a plugin.
      const partialId = candidate.manifest && typeof candidate.manifest.id === 'string' ? candidate.manifest.id : candidate.dirName;
      await rm(path.join(out, partialId), { recursive: true, force: true });
    }
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));

  // 3. Build manifest — lets CI/consumers verify exactly what was built from what.
  const index = {
    name: 'browsermind-plugins',
    generatedAt: new Date().toISOString(),
    generator: 'scripts/build-plugins.ts',
    pluginCount: plugins.length,
    plugins: plugins.map(({ outDir: _outDir, ...rest }) => rest),
  };
  const indexPath = path.join(out, 'index.json');
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  // 4. Optional zips for distribution (drop-in folders or a single archive).
  let zips: string[] | undefined;
  if (options.zip) {
    const zipsDir = path.join(out, '.zips');
    await mkdir(zipsDir, { recursive: true });
    zips = [];
    for (const plugin of plugins) {
      const entries = plugin.files.map((file) => ({
        name: `${plugin.id}/${file.name}`,
        data: readFileSync(path.join(plugin.outDir, file.name)),
      }));
      const zipPath = path.join(zipsDir, `${plugin.id}.zip`);
      await writeFile(zipPath, createZip(entries));
      zips.push(zipPath);
    }
    const allEntries: Array<{ name: string; data: Buffer }> = [];
    for (const plugin of plugins) {
      for (const file of plugin.files) {
        allEntries.push({
          name: `browsermind-plugins/${plugin.id}/${file.name}`,
          data: readFileSync(path.join(plugin.outDir, file.name)),
        });
      }
    }
    allEntries.push({ name: 'browsermind-plugins/index.json', data: await readFile(indexPath) });
    const allZipPath = path.join(zipsDir, 'browsermind-plugins.zip');
    await writeFile(allZipPath, createZip(allEntries));
    zips.push(allZipPath);
    log(`[plugins:build] zips → ${zipsDir} (${zips.length})`);
  }

  return { outDir: out, indexPath, plugins, failed, zips };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Required<BuildPluginsOptions> & { help?: boolean } {
  const options: Required<BuildPluginsOptions> & { help?: boolean } = {
    dir: path.join(root, 'plugins'),
    out: path.join(root, 'build', 'plugins'),
    zip: false,
    minify: false,
    sourcemap: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${arg}`);
      return next;
    };
    if (arg === '--dir') options.dir = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--zip') options.zip = true;
    else if (arg === '--minify') options.minify = true;
    else if (arg === '--sourcemap') options.sourcemap = true;
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option "${arg}" (see --help)`);
  }
  return options;
}

function printHelp(): void {
  console.log(`plugins:build — package plugin folders into a portable, hash-verified build

Usage:
  npx tsx scripts/build-plugins.ts [options]

Options:
  --dir <path>      plugin folder to scan      (default: <repo>/plugins)
  --out <path>      output folder, wiped first (default: <repo>/build/plugins)
  --zip             also write .zips/<id>.zip + .zips/browsermind-plugins.zip
  --minify          minify bundled adapters
  --sourcemap       emit adapter.js.map next to each bundle
  --quiet, -q       only print failures
  --help, -h        this help

Output:
  <out>/index.json     build manifest (id, version, kind, per-file sha256)
  <out>/<id>/          plugin.json ± adapter.js (core imports kept external)`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await buildPlugins(options);
  for (const plugin of result.plugins) {
    if (!options.quiet) {
      const adapter = plugin.files.find((file) => file.name === 'adapter.js');
      const detail =
        adapter && plugin.entry
          ? `${plugin.entry} → adapter.js (${(adapter.size / 1024).toFixed(1)} kB)`
          : 'manifest only';
      console.log(`  ${plugin.id.padEnd(12)} ${plugin.kind.padEnd(12)} ${detail}`);
    }
  }
  console.log(
    `[plugins:build] ${result.plugins.length} packaged plugin(s), ${result.plugins.reduce((sum, p) => sum + p.files.length, 0)} file(s) → ${result.outDir}`,
  );
  if (result.failed.length > 0) {
    for (const failure of result.failed) {
      console.error(`[plugins:build] ${path.basename(failure.dir)}: ${failure.error}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error('[plugins:build] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
