/**
 * Entry-point check — the public entry points must load in Node without a DOM.
 *
 * `@browsermind/core/browser` is what content scripts, the extension and every
 * plugin import; it must never pull in a Node builtin. `@browsermind/core` and
 * `@browsermind/runtime` are the Node-only half. Run with `npm run check:entries`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const core = await import('@browsermind/core');
const browser = await import('@browsermind/core/browser');
const runtime = await import('@browsermind/runtime');

const checks: Array<[string, boolean]> = [
  ['@browsermind/core exports PluginRegistry', typeof core.PluginRegistry === 'function'],
  ['@browsermind/core exports loadPluginsFromDisk', typeof core.loadPluginsFromDisk === 'function'],
  ['@browsermind/core/browser exports PluginRegistry', typeof browser.PluginRegistry === 'function'],
  ['@browsermind/core/browser exports the RPC layer', typeof (browser as { RpcPeer?: unknown }).RpcPeer === 'function'],
  ['@browsermind/core/browser exports the session protocol', typeof (browser as { serveSessionProvider?: unknown }).serveSessionProvider === 'function'],
  ['@browsermind/runtime exports BrowserAIRuntime', typeof runtime.BrowserAIRuntime === 'function'],
];

// The browser entry may not import Node builtins anywhere in its module graph.
const browserSource = readFileSync(resolve(root, 'packages/core/src/browser.ts'), 'utf8');
checks.push(['core/browser barrel avoids node-only modules', !/from '(node:|.*plugin-loader\.js')/.test(browserSource)]);
checks.push(['server protocol constants are shared', typeof (browser as { RUNTIME_METHODS?: unknown }).RUNTIME_METHODS === 'object']);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} entry-point checks OK`);
process.exit(failed === 0 ? 0 : 1);
