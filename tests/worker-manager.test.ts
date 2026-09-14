import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPluginsFromDisk } from '../packages/core/src/plugin-loader.js';
import type { PluginRegistry } from '../packages/core/src/registry.js';
import { WorkerManager } from '../packages/core/src/worker-manager.js';
import { NotFoundError, PageUnavailableError } from '../packages/core/src/errors.js';
import { createSimulatedProvider } from '../packages/testing/src/harness.js';
import { LocalSessionProvider } from '../packages/core/src/local-sessions.js';

let registry: PluginRegistry;
let sandbox: Awaited<ReturnType<typeof createSimulatedProvider>>;
let manager: WorkerManager;

beforeAll(async () => {
  const loaded = await loadPluginsFromDisk();
  registry = loaded.registry;
  sandbox = await createSimulatedProvider({
    registry,
    providers: ['deepseek', 'chatgpt', 'claude'],
  });
  manager = new WorkerManager({ registry, provider: sandbox.provider, defaultTimeoutMs: 20_000 });
  await manager.start();
});

afterAll(async () => {
  await manager.stop();
  await sandbox.destroy();
});

describe('worker manager', () => {
  it('registers one worker per page with provider-prefixed ids', () => {
    const workers = manager.listWorkers();
    expect(workers.map((worker) => worker.id).sort()).toEqual(['chatgpt-1', 'claude-1', 'deepseek-1']);
    expect(workers.every((worker) => worker.status !== 'offline')).toBe(true);
    expect(workers.find((worker) => worker.id === 'deepseek-1')?.capabilities).toContain('deep_think');
  });

  it('runs a task and returns the answer', async () => {
    const result = await manager.sendMessage('deepseek-1', 'Explain workers');
    expect(result.workerId).toBe('deepseek-1');
    expect(result.response).toContain('complete reply');
    expect(result.durationMs).toBeGreaterThan(0);

    const fetched = await manager.getResponse('deepseek-1', { wait: false });
    expect(fetched.taskId).toBe(result.taskId);
    expect(fetched.response).toBe(result.response);
  });

  it('accepts a message without waiting, then answers getResponse', async () => {
    const accepted = await manager.sendMessage('claude-1', 'async please', { waitForResponse: false });
    expect(accepted.response).toBeUndefined();
    const response = await manager.getResponse('claude-1', { wait: true, timeoutMs: 20_000 });
    expect(response.taskId).toBe(accepted.taskId);
    expect(response.response).toContain('complete reply');
  });

  it('serialises tasks of one worker while running workers in parallel', async () => {
    const progress: Record<string, number> = {};
    const unsubscribe = manager.events.on('task.progress', ({ workerId }) => {
      progress[workerId] = (progress[workerId] ?? 0) + 1;
    });
    const started = Date.now();
    await Promise.all([
      manager.sendMessage('deepseek-1', 'one'),
      manager.sendMessage('deepseek-1', 'two'),
      manager.sendMessage('chatgpt-1', 'three'),
      manager.sendMessage('claude-1', 'four'),
    ]);
    const elapsed = Date.now() - started;
    unsubscribe();

    const deepseek = manager.getWorker('deepseek-1');
    expect(deepseek.tasks.completed).toBeGreaterThanOrEqual(3);
    // Four sequential answers would take ~4x a single one; parallel workers are
    // driven by independent pages, so the wall clock stays close to one task.
    expect(elapsed).toBeLessThan(6_000);
    expect(Object.keys(progress).length).toBe(3);
  });

  it('addresses workers by id, provider id or plugin name', async () => {
    expect(manager.getWorker('deepseek').id).toBe('deepseek-1');
    expect(manager.getWorker('DeepSeek Chat').id).toBe('deepseek-1');
    expect(() => manager.getWorker('nope')).toThrow(NotFoundError);
  });

  it('exposes snapshots, capabilities and page actions', async () => {
    const snapshot = await manager.snapshot('deepseek-1');
    expect(snapshot.workerId).toBe('deepseek-1');
    expect(snapshot.capabilities).toContain('file_upload');
    expect(manager.getCapabilities('deepseek-1').capabilities).toContain('chat');

    const toggle = snapshot.availableActions.find((action) => action.id === 'toggle-deep-think');
    expect(toggle?.kind).toBe('toggle');
    const result = (await manager.invoke('deepseek-1', 'toggle-deep-think', true)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('starts a new chat and forgets the previous answer', async () => {
    await manager.sendMessage('chatgpt-1', 'hello');
    expect((await manager.newChat('chatgpt-1')).ok).toBe(true);
    await expect(manager.getResponse('chatgpt-1', { wait: false })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('surfaces page failures as typed errors and keeps the worker usable', async () => {
    // A provider whose page always refuses to work (login wall, quota, …).
    const broken = new LocalSessionProvider({
      registry,
      sessions: [
        {
          pluginId: 'deepseek',
          url: 'https://chat.deepseek.com/broken',
          createAdapter: () => ({
            sendMessage: async () => {
              throw new PageUnavailableError('not signed in');
            },
            waitForResponse: async () => '',
            getStatus: async () => 'blocked' as const,
            snapshot: async () => ({
              workerId: '',
              provider: 'deepseek',
              url: 'https://chat.deepseek.com/broken',
              state: 'login-required',
              status: 'blocked' as const,
              capabilities: ['chat'],
              availableActions: [],
              transcript: [],
              busy: false,
              at: Date.now(),
            }),
            capabilities: () => ['chat'],
          }),
        },
      ],
    });
    const scoped = new WorkerManager({ registry, provider: broken, defaultTimeoutMs: 5_000 });
    await scoped.start();
    const failures: string[] = [];
    const unsubscribe = scoped.events.on('task.failed', (payload) => failures.push(payload.error.code));
    await expect(scoped.sendMessage('deepseek-1', 'hello')).rejects.toBeInstanceOf(PageUnavailableError);
    unsubscribe();
    expect(failures).toEqual(['page_unavailable']);
    const descriptor = scoped.getWorker('deepseek-1');
    expect(descriptor.tasks.failed).toBe(1);
    expect(descriptor.lastError).toMatch(/page_unavailable/);
    await scoped.stop();
  });

  it('keeps the descriptor honest while a task runs', async () => {
    const accepted = await manager.sendMessage('deepseek-1', 'lease a long answer', { waitForResponse: false });
    expect(manager.getWorker(accepted.workerId).tasks.current).toBe(accepted.taskId);
    expect(manager.getWorker(accepted.workerId).status).toBe('busy');
    const answer = await manager.getResponse(accepted.workerId, { wait: true, timeoutMs: 20_000 });
    expect(answer.response).toContain('complete reply');
    expect(manager.getWorker(accepted.workerId).tasks.current).toBeUndefined();
  });
});
