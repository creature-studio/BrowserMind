/**
 * HTTP surface: REST mirror of the MCP tools, the standalone console page and an
 * SSE stream. Useful for debugging, for scripting in languages without MCP
 * clients, and as the human-facing window into the runtime — the console is a
 * normal web page (`/`), not an extension popup.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { toolCatalog } from './tool-catalog.js';
import { createRuntimeApi, httpErrorPayload } from './rpc-api.js';
import type { BrowserAIRuntime } from './runtime.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { CONSOLE_HTML } from './generated/console-html.js';

export interface HttpServerOptions {
  runtime: BrowserAIRuntime;
  port?: number;
  host?: string;
  /** Serve the standalone console page at `/` (and `/console`). */
  consolePage?: boolean;
  /** Serve the lightweight debug dashboard at `/dashboard`. */
  dashboard?: boolean;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { runtime } = options;
  const sseClients = new Set<ServerResponse>();
  const log = options.logger ?? (() => undefined);

  // Every worker/task event is broadcast to dashboard subscribers so streaming
  // answers render live without polling.
  const subscriptions = [
    runtime.workers.events.on('worker.added', (worker) => broadcast('worker', worker)),
    runtime.workers.events.on('worker.updated', (worker) => broadcast('worker', worker)),
    runtime.workers.events.on('worker.removed', (payload) => broadcast('worker.removed', payload)),
    runtime.workers.events.on('task.started', (payload) => broadcast('task.started', payload)),
    runtime.workers.events.on('task.progress', (payload) => broadcast('task.progress', payload)),
    runtime.workers.events.on('task.completed', (payload) => broadcast('task.completed', payload)),
    runtime.workers.events.on('task.failed', (payload) => broadcast('task.failed', payload)),
  ];

  function broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // Paths are derived from `toolCatalog[].http`, so the REST surface and the MCP
  // tools cannot drift apart: one catalog entry means one handler here. Every
  // operation is also reachable as `/api/<tool-name-without-prefix>` and, for
  // clients that would rather not know any paths at all, as
  // `/api/rpc/<browser_ai_tool_name>` — which is what the standalone console page
  // calls, so a renamed path can never break the UI.
  const api = createRuntimeApi(runtime);
  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {};
  for (const tool of toolCatalog) {
    const handler = (body: Record<string, unknown>) => api.call(tool.name, body);
    routes[tool.http] = handler;
    routes[`/api/${tool.name.replace(/^browser_ai_/, '')}`] = handler;
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const body = await readBody(request);

    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    if (CONSOLE_ROUTES.includes(url.pathname)) {
      if (options.consolePage === false) {
        response.writeHead(404).end('console page disabled');
        return;
      }
      sendHtml(response, CONSOLE_HTML || missingConsolePage());
      return;
    }

    if (url.pathname === '/dashboard' || url.pathname === '/dashboard.html') {
      if (options.dashboard === false) {
        response.writeHead(404).end('dashboard disabled');
        return;
      }
      sendHtml(response, DASHBOARD_HTML);
      return;
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`event: hello\ndata: ${JSON.stringify({ workers: runtime.listWorkers() })}\n\n`);
      sseClients.add(response);
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(response);
      });
      return;
    }

    const rpcMatch = /^\/api\/rpc\/([a-z0-9_]+)$/i.exec(url.pathname);
    const route = routes[url.pathname] ?? (rpcMatch ? (body2: Record<string, unknown>) => api.call(qualifyMethod(rpcMatch[1]!), body2) : undefined);
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      return;
    }

    try {
      const payload = url.searchParams.size > 0 ? { ...Object.fromEntries(url.searchParams), ...(body ?? {}) } : body;
      const result = await route(payload ?? {});
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result, null, 2));
      log('http request', { path: url.pathname, method: request.method });
    } catch (error) {
      const { status, body: payload } = httpErrorPayload(error);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload, null, 2));
    }
  }

  const port = options.port ?? 8787;
  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  // `0.0.0.0` binds every interface; it is not a URL you can click, so report the
  // loopback form of the same listener (that is what the console page opens).
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    server,
    async close() {
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

/* ------------------------------- page helpers ------------------------------- */

/** Where the standalone console lives. `/` so it is the first thing you see. */
const CONSOLE_ROUTES = ['/', '/index.html', '/console', '/console.html', '/app'];

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
}

/** Shown when the page was never built — explains the one command that fixes it. */
function missingConsolePage(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<title>BrowserMind — 控制台未构建</title>
<style>body{background:#0b0f19;color:#e6ebf5;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;margin:0;padding:48px}
code{background:#131a2a;border:1px solid #26304a;border-radius:6px;padding:2px 8px;color:#6d8cff}
a{color:#6d8cff}</style></head><body>
<h1>BrowserMind 控制台还没有构建</h1>
<p>控制台是一个独立的网页，构建产物会被打进 runtime。跑一次就行：</p>
<p><code>npm run console:build</code> 然后刷新这个页面</p>
<p>（<code>npm install</code> 已经会自动构建；只想看轻量调试面板：<a href="/dashboard">/dashboard</a>）</p>
</body></html>`;
}

/** `/api/rpc/send_message` and `/api/rpc/browser_ai_send_message` are the same call. */
function qualifyMethod(name: string): string {
  return name.startsWith('browser_ai_') ? name : `browser_ai_${name}`;
}
