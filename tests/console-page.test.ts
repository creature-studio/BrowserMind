/**
 * The standalone page itself: how it is built and how it is served.
 *
 * Two guarantees matter here:
 *   1. the artifact is one self-contained HTML document (no CDN, no static dir),
 *      because it is inlined into the runtime *and* mounted in the extension;
 *   2. `browsermind serve` hands it out at `/`, and every tool it names is
 *      reachable, so the UI cannot drift away from the documented surface.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConsolePage } from '../scripts/build-console.js';
import { CONSOLE_HTML } from '../packages/runtime/src/generated/console-html.js';
import { startHttpServer } from '../packages/runtime/src/http.js';
import { toolCatalog } from '../packages/runtime/src/tool-catalog.js';
import { BrowserAIRuntime } from '../packages/runtime/src/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('console page build', () => {
  it('emits one self-contained document, identical to what the runtime serves', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'browsermind-console-'));
    try {
      const built = await buildConsolePage({ out, injectRuntime: false, quiet: true });
      const html = await readFile(built.htmlPath, 'utf8');

      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('data-console="browsermind"');
      // Inlined: no stylesheet link, no module script src, no external asset.
      expect(html).not.toMatch(/<link[^>]+stylesheet/);
      expect(html).not.toMatch(/<script[^>]+\ssrc=/);
      expect(html).not.toMatch(/https?:\/\/cdn|unpkg|jsdelivr/);
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html.match(/<\/script>/g)).toHaveLength(1);
      expect(html.match(/<style>/g)).toHaveLength(1);
      // The bundle still carries the tool names it talks to, so a rename is caught here.
      expect(html).toContain('browser_ai_send_message');
      expect(built.bytes).toBeGreaterThan(10_000);
      expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);

      // Committed artifact: same content, and no code path may close the script early.
      expect(CONSOLE_HTML.length).toBeGreaterThan(10_000);
      expect(CONSOLE_HTML).toContain('data-console="browsermind"');
      expect(CONSOLE_HTML.match(/<\/script>/g)).toHaveLength(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('runs as built: the artifact mounts itself and drives a runtime', async () => {
    // This is the artifact test: the *bundle*, not the sources. It catches the
    // class of bug where inlining corrupts the script (a `$&` inside minified
    // code being expanded by String.replace, for instance).
    const out = await mkdtemp(path.join(tmpdir(), 'browsermind-run-'));
    try {
      const built = await buildConsolePage({ out, injectRuntime: false, quiet: true });
      const html = await readFile(built.htmlPath, 'utf8');
      const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)?.[1] ?? '';
      expect(script.length).toBeGreaterThan(1000);
      expect(() => new Function(script)).not.toThrow(); // parses as JS in one piece

      const worker = {
        id: 'deepseek-1',
        provider: 'deepseek',
        pluginName: 'DeepSeek',
        status: 'ready',
        capabilities: ['chat', 'stop'],
        url: 'https://chat.deepseek.com/',
        sessionId: 's1',
        location: 'simulator',
        tasks: { total: 0, completed: 0, failed: 0 },
      };
      const calls: unknown[] = [];
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        url: 'http://127.0.0.1:8787/',
        beforeParse(window) {
          const answers: Record<string, unknown> = {
            browser_ai_health: { extension: { connected: 0, port: null, clients: [] }, workers: [worker], plugins: [], simulated: ['deepseek'] },
            browser_ai_list_workers: [worker],
            browser_ai_list_plugins: [{ id: 'deepseek', name: 'DeepSeek', version: '1.0.0', matchPatterns: ['https://chat.deepseek.com/*'], capabilities: ['chat'] }],
            browser_ai_snapshot: {
              workerId: 'deepseek-1',
              provider: 'deepseek',
              url: worker.url,
              state: 'ready',
              status: 'ready',
              capabilities: ['chat'],
              availableActions: [],
              transcript: [],
              busy: false,
              at: 1,
            },
            browser_ai_send_message: { worker: 'deepseek-1', taskId: 'task-3', status: 'accepted' },
            browser_ai_get_response: { workerId: 'deepseek-1', taskId: 'task-3', response: '完整答案 from the built bundle', durationMs: 21 },
            browser_ai_worker_context: { guide: 'guide', tools: [], workers: [worker], plugins: [] },
          };
          (window as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: { body?: string }) => {
            const url = String(input);
            const method = /\/api\/rpc\/([a-z_]+)/.exec(url)?.[1] ?? '';
            const body = JSON.parse(init?.body || '{}') as Record<string, unknown>;
            const payload = answers[method] ?? { error: 'not_found' };
            if (method === 'browser_ai_get_response') calls.push(body);
            if (method === 'browser_ai_send_message') calls.push(body);
            return {
              ok: Boolean(answers[method]),
              status: answers[method] ? 200 : 404,
              headers: { get: () => 'application/json' },
              json: async () => payload,
              text: async () => JSON.stringify(payload),
            } as unknown as Response;
          };
          (window as unknown as { calls: unknown[] }).calls = calls;
          window.EventSource = class {
            onopen: (() => void) | null = null;
            close(): void {}
            addEventListener(): void {}
          } as unknown as typeof EventSource;
        },
      });
      const window = dom.window as unknown as Window & { calls: unknown[] };

      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const thread = window.document.querySelector('#thread');
        if (thread?.textContent?.includes('完整答案 from the built bundle')) break;
        const composer = window.document.querySelector('#composer') as HTMLTextAreaElement | null;
        if (composer && attempt === 20 && !composer.value) {
          composer.value = '来自打包产物的问题';
          (window.document.querySelector('.composer button.primary') as HTMLButtonElement | null)?.click();
        }
      }

      expect(window.document.querySelector('.shell')).not.toBeNull();
      expect(window.document.querySelector('#worker-list .worker')?.textContent).toContain('deepseek-1');
      expect(window.document.querySelector('#thread')?.textContent).toContain('完整答案 from the built bundle');
      expect((window.calls ?? []).some((call) => (call as { message?: string }).message === '来自打包产物的问题')).toBe(true);
      dom.window.close();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('refuses to build when the inlining markers move', async () => {
    // The page is inlined by string replacement, so the contract with index.html
    // is those two marker tags. Losing one must fail the build, not ship a blank page.
    const file = path.join(root, 'packages', 'console', 'index.html');
    const out = await mkdtemp(path.join(tmpdir(), 'browsermind-markers-'));
    const original = await readFile(file, 'utf8');
    try {
      await writeFile(file, original.replace('<script type="module" src="./src/main.ts"></script>', ''), 'utf8');
      await expect(buildConsolePage({ out, quiet: true })).rejects.toThrow(/inlining markers/);
    } finally {
      await writeFile(file, original, 'utf8');
      await rm(out, { recursive: true, force: true });
    }
  });

  it('keeps the catalog the only source of the API surface', () => {
    // The page names tools (`browser_ai_*`) and never a path; the server expands
    // the catalog into REST routes. A duplicate or renamed entry is a contract
    // change, so it has to show up here first.
    const names = toolCatalog.map((tool) => tool.name);
    const paths = toolCatalog.map((tool) => tool.http);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(names).toContain('browser_ai_send_message');
    expect(paths).toContain('/api/workers');
    expect(toolCatalog).toHaveLength(13);
    for (const name of names) expect(name).toMatch(/^browser_ai_[a-z_]+$/);
  });
});

describe('serving the standalone page', () => {
  let runtime: BrowserAIRuntime;
  let http: Awaited<ReturnType<typeof startHttpServer>>;
  let base = '';

  beforeAll(async () => {
    runtime = await BrowserAIRuntime.create({ simulate: ['mock'], startBridge: false, logLevel: 'silent' });
    await runtime.start();
    http = await startHttpServer({ runtime, port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${http.port}`;
  }, 30_000);

  afterAll(async () => {
    await http.close();
    await runtime.shutdown();
  });

  it('answers / and /console with the console, /dashboard with the debug view', async () => {
    for (const route of ['/', '/console', '/app']) {
      const response = await fetch(`${base}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('data-console="browsermind"');
      expect(html).toContain('BrowserMind 控制台');
    }
    const dashboard = await fetch(`${base}/dashboard`).then((response) => response.text());
    expect(dashboard).toContain('Browser AI Worker Runtime');
    expect(dashboard).not.toContain('data-console="browsermind"');
  });

  it('answers every tool by name, and keeps the documented REST paths', async () => {
    const post = (url: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (const tool of toolCatalog) {
      // `/api/rpc/<tool>` is what the console page calls; the two other spellings
      // are what the docs promise. Missing parameters are a 400, never a 404.
      for (const url of [`${base}${tool.http}`, `${base}/api/${tool.name.replace(/^browser_ai_/, '')}`, `${base}/api/rpc/${tool.name}`]) {
        const response = await post(url);
        if (response.status === 404) {
          // A router 404 carries `path` and no message; a handler 404 (e.g. "no
          // task yet") is a real answer. Only the first one would be a drift bug.
          const body = (await response.json()) as { path?: string; message?: string };
          expect(body.path, `${url} has no route`).toBeUndefined();
          expect(body.message).toBeTruthy();
        } else {
          expect([200, 400, 422], url).toContain(response.status);
        }
      }
    }
    const unknownPath = await post(`${base}/api/nope`);
    expect(unknownPath.status).toBe(404);
    expect(await unknownPath.json()).toMatchObject({ error: 'not_found' });

    const unknownMethod = await post(`${base}/api/rpc/browser_ai_fly`);
    expect(unknownMethod.status).toBe(404);
    expect((await unknownMethod.json()).message).toContain('Unknown method');
  });

  it('is a plain client of the REST mirror the page uses', async () => {
    const workers = await fetch(`${base}/api/workers`).then((response) => response.json());
    expect(workers[0]?.id).toBe('mock-1');

    const sent = await fetch(`${base}/api/rpc/browser_ai_send_message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: 'mock-1', message: 'from the console page test' }),
    }).then((response) => response.json());
    expect(sent.response).toContain('complete reply');
    expect(sent.worker).toBe('mock-1');

    const context = await fetch(`${base}/api/context`, { method: 'POST' }).then((response) => response.json());
    expect(context.guide).toContain('BrowserMind');
    expect(context.tools).toHaveLength(13);
  });

  it('keeps REST errors machine readable', async () => {
    const badWorker = await fetch(`${base}/api/send_message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: 'ghost-9', message: 'x' }),
    });
    expect(badWorker.status).toBeGreaterThanOrEqual(400);
    const payload = await badWorker.json();
    expect(payload.message).toBeTruthy();
  });

  it('streams worker and task events over SSE', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    const first = reader ? decoder.decode((await reader.read()).value ?? new Uint8Array()) : '';
    expect(first).toContain('event: hello');
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });
});
