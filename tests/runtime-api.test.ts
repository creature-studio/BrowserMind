/**
 * The `browser_ai.*` table as the extension's own pages see it.
 *
 * This is the wire behind the standalone console tab: an extension page sends
 * `{ type: 'runtime.request', method: 'browser_ai_send_message' }` to the
 * background, the background forwards the *tool name* over the bridge, and the
 * runtime answers from the same table the MCP server and the REST API use. It
 * used to be a dead end there (`No handler for "browser_ai_send_message"`), which
 * is exactly the failure this test now pins.
 */
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_METHODS, RpcPeer, createWebSocketChannel } from '../packages/core/src/index.js';
import { BrowserAIRuntime } from '../packages/runtime/src/runtime.js';

let runtime: BrowserAIRuntime;
let peer: RpcPeer;
let socket: WebSocket;
const received: Array<{ method: string; params: unknown }> = [];

beforeAll(async () => {
  runtime = await BrowserAIRuntime.create({ simulate: ['mock'], extensionPort: 0, logLevel: 'silent' });
  const started = await runtime.start();
  socket = new WebSocket(`ws://127.0.0.1:${started.extensionPort}/browsermind/extension`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  peer = new RpcPeer(createWebSocketChannel(socket as never), { name: 'test-console', timeoutMs: 30_000 });
  peer.onEvent((event) => received.push(event));
  expect(await runtime.waitForExtension(10_000)).toBe(true);
}, 30_000);

afterAll(async () => {
  peer.close();
  socket.close();
  await runtime.shutdown();
});

describe('runtime tool RPC (extension pages)', () => {
  it('answers the tool surface the agents use', async () => {
    const workers = await peer.request<Array<{ id: string; status: string }>>('browser_ai_list_workers');
    expect(workers.map((worker) => worker.id)).toContain('mock-1');

    const health = await peer.request<{ workers: unknown[]; plugins: unknown[] }>('browser_ai_health');
    expect(health.workers.length).toBeGreaterThan(0);
    expect(health.plugins.length).toBeGreaterThanOrEqual(6);

    const plugins = await peer.request<Array<{ id: string }>>('browser_ai_list_plugins');
    expect(plugins.map((plugin) => plugin.id)).toContain('deepseek');
  });

  it('sends a message and waits for the answer, camel or snake case', async () => {
    const result = await peer.request<{ worker: string; response: string; status: string }>('browser_ai_send_message', {
      worker: 'mock-1',
      message: 'hello from the console page',
      wait: true,
      timeout_ms: 20_000,
    });
    expect(result.worker).toBe('mock-1');
    expect(result.status).toBe('completed');
    expect(result.response).toContain('complete reply');

    const camel = await peer.request<{ response: string }>('browser_ai_send_message', {
      provider: 'mock',
      message: 'second prompt',
      wait: true,
      timeoutMs: 20_000,
    });
    expect(camel.response).toContain('complete reply');
  });

  it('streams task frames to the connected page', async () => {
    received.length = 0;
    await runtime.sendMessage({ worker: 'mock-1', message: 'stream please', timeoutMs: 20_000 });
    // Frames are one-way, so wait for the last one instead of reading a snapshot.
    const kinds = async (): Promise<string[]> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const list = received
          .filter((event) => event.method === RUNTIME_METHODS.events)
          .map((event) => (event.params as { kind: string }).kind);
        if (list.includes('task.completed') || Date.now() > deadline) return list;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const frames = await kinds();
    expect(frames).toContain('task.started');
    expect(frames).toContain('task.progress');
    expect(frames).toContain('task.completed');
    const progress = received.find((event) => (event.params as { kind: string }).kind === 'task.progress');
    expect((progress?.params as { payload: { workerId: string } }).payload.workerId).toBe('mock-1');
  });

  it('answers snapshots, actions and installs over the same socket', async () => {
    const snapshot = await peer.request<{ capabilities: string[]; availableActions: unknown[] }>('browser_ai_snapshot', {
      worker: 'mock-1',
      transcript: true,
    });
    expect(snapshot.capabilities).toContain('chat');
    expect(Array.isArray(snapshot.availableActions)).toBe(true);

    const installed = await peer.request<{ id: string }>('browser_ai_install_plugin', {
      manifest: {
        id: 'rpc-installed',
        name: 'RPC Installed',
        version: '1.0.0',
        matchPatterns: ['https://rpc.example.com/*'],
        capabilities: ['chat'],
        selectors: { input: ['textarea'], response: ['.answer'] },
      },
      persist: false,
    });
    expect(installed.id).toBe('rpc-installed');
    expect(runtime.listPlugins().map((plugin) => plugin.id)).toContain('rpc-installed');
  });

  it('refuses methods that are not part of the contract', async () => {
    // The socket only answers catalogued names, so a typo fails loudly instead of
    // hanging until the caller's timeout.
    await expect(peer.request('browser_ai_do_anything')).rejects.toMatchObject({
      code: 'method_not_found',
      message: expect.stringContaining('No handler'),
    });
    // And the shared table says the same thing when it is called directly.
    await expect(runtime.api.call('browser_ai_do_anything')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('Unknown method'),
    });
    await expect(runtime.api.call('browser_ai_send_message', { worker: 'mock-1' })).rejects.toThrow(/`message` is required/);
  });
});
