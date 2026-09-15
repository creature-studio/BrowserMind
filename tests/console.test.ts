// @vitest-environment jsdom
/**
 * The standalone console page — rendered in jsdom against a stub transport.
 *
 * This is the closest thing to clicking through the UI without a browser, and it
 * pins the two properties the page exists for: it is a *page* (mounted into
 * `#app`, no extension APIs at all) and it is a pure client of the documented
 * `browser_ai.*` surface (every interaction below turns into exactly one tool
 * call with the same parameters an agent would send).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountConsole, type ConsoleHandle } from '../packages/console/src/app.js';
import type { ConsoleEvent, ConsoleTransport } from '../packages/console/src/types.js';

const worker = {
  id: 'deepseek-1',
  provider: 'deepseek',
  pluginName: 'DeepSeek',
  status: 'ready' as const,
  capabilities: ['chat', 'stop', 'deep_think'],
  url: 'https://chat.deepseek.com/',
  title: 'DeepSeek',
  sessionId: 'page-1',
  location: 'page' as const,
  tasks: { total: 1, completed: 1, failed: 0 },
};

const plugin = {
  id: 'deepseek',
  name: 'DeepSeek',
  version: '1.0.0',
  matchPatterns: ['https://chat.deepseek.com/*'],
  capabilities: ['chat'],
  source: 'builtin',
};

const snapshot = {
  workerId: 'deepseek-1',
  provider: 'deepseek',
  url: worker.url,
  state: 'ready',
  status: 'ready' as const,
  capabilities: worker.capabilities,
  availableActions: [
    { id: 'toggle-deep-think', label: '深度思考', kind: 'toggle' as const, enabled: true, value: false },
    { id: 'attach-file', label: '附件', kind: 'upload' as const, enabled: false, reason: 'page is busy' },
  ],
  transcript: [{ role: 'user' as const, text: '上一条问题', at: Date.now() }],
  busy: false,
  at: Date.now(),
};

interface Stub {
  transport: ConsoleTransport;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  emit(event: ConsoleEvent): void;
}

function createStub(overrides: Record<string, unknown> = {}): Stub {
  const listeners = new Set<(event: ConsoleEvent) => void>();
  const calls: Stub['calls'] = [];
  const responses: Record<string, unknown> = {
    browser_ai_health: { extension: { connected: 1, port: 8765, clients: [] }, workers: [worker], plugins: [plugin], simulated: [] },
    browser_ai_list_workers: [worker],
    browser_ai_list_plugins: [plugin],
    browser_ai_snapshot: snapshot,
    browser_ai_send_message: { worker: 'deepseek-1', taskId: 'task-9', status: 'accepted' },
    browser_ai_get_response: { workerId: 'deepseek-1', taskId: 'task-9', response: '这是完整回答 complete reply', durationMs: 42 },
    browser_ai_stop_worker: { id: 'deepseek-1', stopped: true },
    browser_ai_new_chat: { id: 'deepseek-1', ok: true },
    browser_ai_close_worker: { id: 'deepseek-1', closed: true },
    browser_ai_invoke_action: { ok: true },
    browser_ai_install_plugin: { id: 'acme-chat', name: 'ACME Chat', version: '1.0.0' },
    browser_ai_worker_context: { guide: 'guide text', tools: [], workers: [worker], plugins: [plugin] },
    ...overrides,
  };
  return {
    calls,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    transport: {
      kind: 'web',
      label: 'stub runtime',
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push({ method, params });
        if (!(method in responses)) throw new Error(`stub: unexpected method ${method}`);
        return responses[method] as T;
      },
      subscribe(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
  };
}

let handle: ConsoleHandle | null = null;

async function mount(stub: Stub): Promise<ConsoleHandle> {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.replaceChildren(root);
  handle = mountConsole(root, stub.transport);
  // The first paint happens before any data; drive one refresh ourselves so the
  // assertions below start from a settled page.
  await handle.actions.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return handle;
}

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.replaceChildren();
});

describe('standalone console page', () => {
  it('renders workers, plugins and a snapshot in one page', async () => {
    const stub = createStub();
    await mount(stub);

    expect(document.querySelector('.shell')).not.toBeNull();
    const card = document.querySelector('#worker-list .worker');
    expect(card?.textContent).toContain('deepseek-1');
    expect(card?.textContent).toContain('就绪');
    expect(document.querySelector('#inspector')?.textContent).toContain('深度思考');
    expect(document.querySelector('#plugin-table table')?.textContent).toContain('chat.deepseek.com');
    // A snapshot is pulled as soon as a worker is selected.
    expect(stub.calls.some((call) => call.method === 'browser_ai_snapshot' && call.params.worker === 'deepseek-1')).toBe(true);
  });

  it('sends a prompt without blocking, then adopts the answer', async () => {
    const stub = createStub();
    await mount(stub);

    const composer = document.querySelector<HTMLTextAreaElement>('#composer')!;
    composer.value = '总结这个项目';
    document.querySelector<HTMLButtonElement>('.composer button.primary')!.click();

    await vi.waitFor(() => {
      const bubbles = document.querySelectorAll('#thread .msg');
      expect(bubbles.length).toBe(2);
      expect(bubbles[1]?.textContent).toContain('这是完整回答 complete reply');
    });

    const send = stub.calls.find((call) => call.method === 'browser_ai_send_message');
    expect(send?.params).toMatchObject({ worker: 'deepseek-1', message: '总结这个项目', wait: false });
    const wait = stub.calls.find((call) => call.method === 'browser_ai_get_response');
    expect(wait?.params).toMatchObject({ worker: 'deepseek-1', task_id: 'task-9', wait: true });
  });

  it('renders streamed text coming from live events', async () => {
    const stub = createStub({ browser_ai_get_response: new Promise(() => undefined) /* keep it streaming */ });
    await mount(stub);

    const composer = document.querySelector<HTMLTextAreaElement>('#composer')!;
    composer.value = '写一段长答案';
    document.querySelector<HTMLButtonElement>('.composer button.primary')!.click();

    await vi.waitFor(() => expect(document.querySelector('#thread .msg.streaming')).not.toBeNull());
    stub.emit({ kind: 'task.progress', payload: { workerId: 'deepseek-1', taskId: 'task-9', text: '第一段已经写好了' } });
    await vi.waitFor(() => expect(document.querySelector('#thread .msg.streaming')?.textContent).toContain('第一段已经写好了'));

    stub.emit({ kind: 'task.completed', payload: { workerId: 'deepseek-1', taskId: 'task-9', response: '第一段已经写好了\n\n完', durationMs: 300 } });
    await vi.waitFor(() => expect(document.querySelector('#thread .msg:last-child')?.textContent).toContain('完'));
    expect(document.querySelector('#thread .msg.streaming')).toBeNull();
    // The task was started by the agent on this same worker: only one bubble pair.
    expect(document.querySelectorAll('#thread .msg').length).toBe(2);
  });

  it('adopts a task that an agent started while nobody was looking', async () => {
    const stub = createStub();
    await mount(stub);

    stub.emit({ kind: 'task.started', payload: { workerId: 'deepseek-1', taskId: 'task-77', message: 'MCP 侧发来的提示词', at: Date.now() } });
    await vi.waitFor(() => expect(document.querySelector('#thread')?.textContent).toContain('MCP 侧发来的提示词'));
    expect(document.querySelectorAll('#thread .msg.user').length).toBe(1);

    stub.emit({ kind: 'task.failed', payload: { workerId: 'deepseek-1', taskId: 'task-77', error: { code: 'timeout', message: 'provider stalled' } } });
    await vi.waitFor(() => expect(document.querySelector('#thread')?.textContent).toContain('provider stalled'));
  });

  it('exposes page actions as capability chips, never as selectors', async () => {
    const stub = createStub();
    await mount(stub);

    const toggle = document.querySelector<HTMLButtonElement>('#inspector .chip.action');
    expect(toggle?.textContent).toContain('深度思考');
    toggle!.click();
    await vi.waitFor(() => {
      const invoked = stub.calls.find((call) => call.method === 'browser_ai_invoke_action');
      expect(invoked?.params).toMatchObject({ worker: 'deepseek-1', action_id: 'toggle-deep-think' });
    });
    expect(document.querySelector('#inspector .chip.action[disabled]')?.textContent).toContain('附件');
    // No CSS anywhere in the page's own state.
    const inspectorJson = document.querySelector('#inspector details')?.textContent ?? '';
    expect(inspectorJson).not.toMatch(/querySelector|cssText|\[class~=/);
  });

  it('installs a provider from a manifest alone', async () => {
    const stub = createStub();
    await mount(stub);

    const box = document.querySelector<HTMLTextAreaElement>('textarea.code')!;
    box.value = JSON.stringify({ id: 'acme-chat', name: 'ACME', version: '1.0.0', matchPatterns: ['https://chat.example.com/*'], capabilities: ['chat'], selectors: { input: ['textarea'] } });
    document.querySelector<HTMLButtonElement>('.tab .primary')?.click();

    await vi.waitFor(() => {
      const install = stub.calls.find((call) => call.method === 'browser_ai_install_plugin');
      expect(install?.params).toMatchObject({ persist: false, replace: true });
      expect((install?.params.manifest as { id: string }).id).toBe('acme-chat');
    });
  });

  it('tells a human what is wrong when there is no runtime link', async () => {
    const stub = createStub({
      browser_ai_health: { extension: { connected: 0, port: null, clients: [] }, workers: [], plugins: [plugin], simulated: [] },
      browser_ai_list_workers: [],
    });
    await mount(stub);

    await vi.waitFor(() => expect(document.querySelector('#diagnostics')?.textContent).toContain('没有 worker'));
    expect(document.querySelector('#worker-list .empty')?.textContent).toContain('--simulate all');
    expect(document.querySelector('#diagnostics')?.textContent).toContain('还没有浏览器扩展连上来');
  });
});
