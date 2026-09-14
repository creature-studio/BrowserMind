/**
 * Runtime ↔ extension protocol, exercised over a real WebSocket.
 *
 * The browser side of the wire is played by `serveSessionProvider` on top of a
 * `LocalSessionProvider` — the same core primitives `packages/extension`'s
 * background worker uses — while the runtime side is the real
 * `BrowserAIRuntime` with its extension bridge listening.
 *
 * This is the closest we can get to `attachExtension()` without Chrome, and it
 * covers everything that is *not* Chrome-specific: session discovery, remote
 * task submission, streamed progress frames, DOM tunnelling and plugin catalog
 * pushes.
 */
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RUNTIME_METHODS,
  RpcPeer,
  SESSION_EVENTS,
  SESSION_METHODS,
  createWebSocketChannel,
  serveSessionProvider,
  type OpenSessionRequest,
  type PageSession,
  type PluginDescriptor,
  type PluginManifest,
  type SessionInfo,
  type WorkerDescriptor,
} from '../packages/core/src/index.js';
import { loadPluginsFromDisk } from '../packages/core/src/plugin-loader.js';
import { LocalSessionProvider } from '../packages/core/src/local-sessions.js';
import { BrowserAIRuntime } from '../packages/runtime/src/runtime.js';
import { createFakeSite, type FakeSite } from '../packages/testing/src/fake-site.js';

let runtime: BrowserAIRuntime;
let provider: LocalSessionProvider;
let peer: RpcPeer;
let socket: WebSocket;
let deepseekSite: FakeSite;
let mockSite: FakeSite;
let port = 0;

/** Everything the runtime pushed to the extension. */
const notifications: Array<{ method: string; params: unknown }> = [];
/** Streaming frames the extension pushed back to the runtime. */
const progressFrames: string[] = [];

const toInfo = (session: PageSession): SessionInfo => ({
  id: session.id,
  pluginId: session.pluginId,
  url: session.url,
  title: session.title,
  tabId: session.tabId,
  capabilities: session.capabilities ?? [],
  location: session.location,
});

async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs = 8_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  const loaded = await loadPluginsFromDisk();
  runtime = await BrowserAIRuntime.create({
    plugins: loaded.registry.entries().map((entry) => entry.plugin),
    extensionPort: 0, // let the OS pick a free port
    startBridge: true,
    logLevel: 'silent',
  });
  const started = await runtime.start();
  port = started.extensionPort ?? 0;
  expect(port).toBeGreaterThan(0);

  // ---- the "browser" half of the wire ------------------------------------
  deepseekSite = createFakeSite({ provider: 'deepseek', chunkDelayMs: 8, firstChunkDelayMs: 4 });
  mockSite = createFakeSite({ provider: 'mock', chunkDelayMs: 8, firstChunkDelayMs: 4 });
  provider = new LocalSessionProvider({ registry: loaded.registry, kind: 'page' });
  await provider.addSession({
    pluginId: 'deepseek',
    url: deepseekSite.url,
    title: 'DeepSeek',
    driver: deepseekSite.driver,
    domDriver: deepseekSite.driver,
  });

  socket = new WebSocket(`ws://127.0.0.1:${port}/browsermind/extension`);
  // Subscribe *before* the socket opens: the runtime's first frame
  // (`session.list`) may arrive before `open` reaches us, and the peer itself
  // is only built a moment later — the channel buffers in between.
  const channel = createWebSocketChannel(socket as unknown as Parameters<typeof createWebSocketChannel>[0]);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  peer = new RpcPeer(channel, { name: 'test-extension', timeoutMs: 60_000 });
  peer.onEvent(({ method, params }) => notifications.push({ method, params }));
  serveSessionProvider(peer, {
    list: () => provider.list().map(toInfo),
    open: async (request: OpenSessionRequest) => toInfo(await provider.open(request)),
    getSession: (sessionId: string) => provider.get(sessionId),
    close: (sessionId: string) => provider.close(sessionId),
    navigate: (sessionId: string, url: string) => provider.navigate(sessionId, url),
    heartbeat: async () => ({ at: Date.now() }),
    notify: (method, params) => {
      if (method === SESSION_EVENTS.progress) progressFrames.push((params as { text: string }).text);
      peer.notify(method, params);
    },
  });

  expect(await runtime.waitForExtension(10_000)).toBe(true);
  await waitFor(() => runtime.listWorkers().find((worker) => worker.id === 'deepseek-1'), 8_000, 'browser worker to register');
}, 30_000);

afterAll(async () => {
  await runtime.shutdown();
  deepseekSite.destroy();
  mockSite.destroy();
});

describe('extension bridge', () => {
  it('registers the browser pages the extension lists', () => {
    expect(runtime.status().extension.connected).toBe(1);
    const worker = runtime.listWorkers().find((entry) => entry.id === 'deepseek-1');
    expect(worker?.provider).toBe('deepseek');
    expect(worker?.location).toBe('page');
  });

  it('serves runtime state to the extension', async () => {
    const state = await peer.request<{ workers: WorkerDescriptor[]; plugins: PluginDescriptor[] }>(RUNTIME_METHODS.state);
    expect(state.workers.map((worker) => worker.id)).toContain('deepseek-1');
    expect(state.plugins.length).toBeGreaterThanOrEqual(6);
    // The attach routine immediately pushes the worker list + plugin catalog.
    expect(notifications.some((notification) => notification.method === RUNTIME_METHODS.workers)).toBe(true);
    expect(notifications.some((notification) => notification.method === RUNTIME_METHODS.plugins)).toBe(true);
  });

  it('drives the page through the socket and streams the answer back', async () => {
    const result = await runtime.sendMessage({
      worker: 'deepseek-1',
      message: 'hello over the websocket',
      timeoutMs: 20_000,
    });
    expect(result.response).toContain('complete reply');
    expect(deepseekSite.submissions).toEqual(['hello over the websocket']);
    // Progress frames really travelled extension → runtime, not through a local adapter.
    expect(progressFrames.length).toBeGreaterThan(0);
    expect(progressFrames[progressFrames.length - 1]).toBe(result.response);
  });

  it('returns provider-agnostic snapshots over the socket', async () => {
    const snapshot = await runtime.snapshot({ worker: 'deepseek-1' });
    expect(snapshot.provider).toBe('deepseek');
    expect(snapshot.capabilities).toContain('chat');
    expect(snapshot.availableActions.map((action) => action.id)).toContain('chat');
    expect(JSON.stringify(snapshot)).not.toMatch(/querySelector|#prompt-input|ds-markdown/);
  });

  it('tunnels DOM access from the runtime to the page (sandboxed plugins)', async () => {
    const session = provider.list().find((entry) => entry.pluginId === 'deepseek');
    expect(session).toBeTruthy();
    // The runtime's peer asks the extension for DOM access, exactly like a
    // sandboxed plugin host would; the page-side driver answers.
    const runtimePeer = runtime.bridge?.clients[0]?.peer;
    expect(runtimePeer).toBeTruthy();
    const info = await runtimePeer!.request<{ url: string; title: string }>(SESSION_METHODS.domCall, {
      sessionId: session!.id,
      method: 'info',
      args: [],
    });
    expect(info.url).toBe(deepseekSite.url);
    expect(info.title).toBe(deepseekSite.document.title);
  });

  it('sees a tab that opens later', async () => {
    const session = await provider.addSession({
      pluginId: 'mock',
      url: mockSite.url,
      title: 'Mock chat',
      driver: mockSite.driver,
      domDriver: mockSite.driver,
    });
    peer.notify(SESSION_EVENTS.added, { sessions: [toInfo(session)] });
    const worker = await waitFor(
      () => runtime.listWorkers().find((entry) => entry.provider === 'mock'),
      8_000,
      'late tab worker',
    );
    expect(worker.id).toBe('mock-1');

    const answer = await runtime.sendMessage({
      worker: worker.id,
      message: 'second tab, same runtime',
      timeoutMs: 20_000,
    });
    expect(answer.response).toContain('complete reply');
    expect(mockSite.submissions).toEqual(['second tab, same runtime']);
  });

  it('broadcasts the plugin catalog when a plugin is installed', async () => {
    const manifest: PluginManifest = {
      id: 'x-acme',
      name: 'ACME Chat',
      version: '1.0.0',
      matchPatterns: ['https://chat.acme.example/*'],
      capabilities: ['chat'],
      selectors: { input: ['textarea'], response: ['.answer'] },
    };
    await runtime.installPlugin(manifest, { persist: false });
    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === RUNTIME_METHODS.plugins &&
            (notification.params as { plugins?: PluginDescriptor[] }).plugins?.some((plugin) => plugin.id === 'x-acme'),
        ),
      8_000,
      'plugin catalog push',
    );
  });

  it('drops the browser workers when the extension disconnects', async () => {
    socket.close();
    await waitFor(() => runtime.listWorkers().length === 0, 8_000, 'workers to be removed');
    expect(runtime.status().extension.connected).toBe(0);
  });
});
