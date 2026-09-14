/**
 * HTTP surface: REST mirror of the MCP tools plus a small live dashboard and an
 * SSE stream. Useful for debugging, for scripting in languages without MCP
 * clients, and as the human-facing window into the runtime.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { toErrorPayload } from '@browsermind/core';
import type { BrowserAIRuntime } from './runtime.js';
import { DASHBOARD_HTML } from './dashboard.js';

export interface HttpServerOptions {
  runtime: BrowserAIRuntime;
  port?: number;
  host?: string;
  /** Serve the dashboard at `/`. */
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

  // Paths mirror `toolCatalog[].http` one-to-one so the REST and MCP surfaces
  // never drift apart.
  const routes: Record<string, (body: any) => Promise<unknown>> = {
    '/api/health': async () => runtime.status(),
    '/api/workers': async () => runtime.listWorkers(),
    '/api/plugins': async () => runtime.listPlugins(),
    '/api/context': async () => ({
      workers: runtime.listWorkers(),
      plugins: runtime.listPlugins(),
      extension: runtime.status().extension,
    }),
    '/api/send_message': async (body) => {
      const result = await runtime.sendMessage({
        worker: body.worker,
        provider: body.provider,
        message: body.message ?? body.prompt,
        wait: body.wait,
        timeoutMs: body.timeout_ms ?? body.timeoutMs,
        newChat: body.new_chat ?? body.newChat,
        files: body.files,
      });
      return { worker: result.workerId, taskId: result.taskId, response: result.response, durationMs: result.durationMs };
    },
    '/api/get_response': async (body) =>
      runtime.getResponse({
        worker: body.worker,
        provider: body.provider,
        taskId: body.task_id ?? body.taskId,
        wait: body.wait,
        timeoutMs: body.timeout_ms ?? body.timeoutMs,
      }),
    '/api/snapshot': async (body) =>
      runtime.snapshot({ worker: body.worker, provider: body.provider, transcript: body.transcript }),
    '/api/open_worker': async (body) => runtime.openWorker({ provider: body.provider, url: body.url, reuse: body.reuse }),
    '/api/close_worker': async (body) => runtime.closeWorker(body.worker),
    '/api/stop_worker': async (body) => runtime.stopWorker(body.worker),
    '/api/new_chat': async (body) => runtime.newChat(body.worker),
    '/api/invoke_action': async (body) => runtime.invoke(body.worker, body.action_id ?? body.actionId, body.value),
    '/api/install_plugin': async (body) =>
      runtime.installPlugin(body.manifest, { persist: body.persist, replace: body.replace ?? true }),
  };

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

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (options.dashboard === false) {
        response.writeHead(404).end('dashboard disabled');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(DASHBOARD_HTML);
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

    const route = routes[url.pathname];
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
      const payload = toErrorPayload(error);
      response.writeHead(payload.code === 'not_found' ? 404 : 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: payload.code, message: payload.message }, null, 2));
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

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
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
