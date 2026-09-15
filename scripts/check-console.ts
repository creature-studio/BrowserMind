#!/usr/bin/env tsx
/**
 * Console check — build the standalone page and drive it end to end.
 *
 * Run with `npm run check:console`. Like `check:plugins` this lives outside vitest so
 * it can be run on its own (and read by a human) and so it exercises the *real*
 * server: build the page, boot `browsermind serve`, fetch `/`, then talk to the
 * runtime through the same endpoints the page talks to.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsolePage } from './build-console.js';
import { BrowserAIRuntime } from '../packages/runtime/src/runtime.js';
import { startHttpServer } from '../packages/runtime/src/http.js';
import { toolCatalog } from '../packages/runtime/src/tool-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks: Array<[string, boolean, string?]> = [];
const add = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail]);

let runtime: BrowserAIRuntime | null = null;
let http: Awaited<ReturnType<typeof startHttpServer>> | null = null;

try {
  /* 1. the artifact */
  const built = await buildConsolePage({ out: path.join(root, 'build', 'console'), quiet: true });
  const html = await readFile(built.htmlPath, 'utf8');
  add(`page builds into one file (${(built.bytes / 1024).toFixed(1)} kB)`, built.bytes > 10_000, built.htmlPath);
  add('page is self-contained (no external css/js)', !/<link[^>]+stylesheet|<script[^>]+\ssrc=/.test(html));
  add('page is what `serve` answers at /', html.includes('data-console="browsermind"') && html.includes('BrowserMind 控制台'));

  /* 2. the real server, with simulated workers */
  runtime = await BrowserAIRuntime.create({ simulate: ['mock', 'deepseek'], startBridge: false, logLevel: 'silent' });
  await runtime.start();
  http = await startHttpServer({ runtime, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${http.port}`;

  const page = await fetch(`${base}/`);
  add('GET / → 200 text/html', page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'));
  const dashboard = await fetch(`${base}/dashboard`);
  add('GET /dashboard → 200 (legacy debug view still available)', dashboard.status === 200);

  const workers = (await fetch(`${base}/api/workers`).then((r) => r.json())) as Array<{ id: string; status: string }>;
  add(`workers from the simulator (${workers.map((w) => w.id).join(', ')})`, workers.length >= 2);

  /* 3. the exact calls the page makes */
  const byName = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}/api/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const health = await byName('browser_ai_health');
  add('browser_ai_health over the RPC endpoint', health.status === 200 && Boolean((health.body as { plugins?: unknown[] })?.plugins?.length));
  const listed = await byName('browser_ai_list_workers');
  add('browser_ai_list_workers over the RPC endpoint', Array.isArray(listed.body) && listed.body.length > 0);

  const target = workers[0]?.id ?? 'mock-1';
  const accepted = await byName('browser_ai_send_message', { worker: target, message: 'check:console 发来的消息', wait: false });
  add(`send_message (wait:false) 被 ${target} 接受`, accepted.status === 200 && Boolean((accepted.body as { taskId?: string })?.taskId));
  const answered = await byName('browser_ai_send_message', { worker: target, message: 'check:console 等待回答', wait: true, timeout_ms: 20_000 });
  add('send_message (wait:true) 拿到完整回答', (answered.body as { response?: string })?.response?.includes('complete reply') === true);

  const snapshot = await byName('browser_ai_snapshot', { worker: target, transcript: true });
  const snapshotBody = snapshot.body as { capabilities?: string[]; availableActions?: unknown[]; url?: string };
  add('snapshot 只有 capability，没有 selector', (snapshotBody?.capabilities?.length ?? 0) > 0 && !JSON.stringify(snapshotBody).includes('querySelector'));

  const all = await Promise.all(toolCatalog.map((tool) => fetch(`${base}${tool.http}`, { method: 'POST', body: '{}' }).then((r) => r.status)));
  add(`${toolCatalog.length} 个工具全部有 REST 路由`, !all.includes(404));

  let failures = 0;
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  }
  console.log(`\n${checks.length - failures}/${checks.length} console checks OK  (page ${(built.bytes / 1024).toFixed(1)} kB, sha ${built.sha256.slice(0, 12)})`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error('[check:console] crashed:', error);
  process.exitCode = 1;
} finally {
  await http?.close();
  await runtime?.shutdown();
}
