/**
 * Console state.
 *
 * One store, all mutations funnelled through `actions`. Every action is a call
 * to the documented `browser_ai.*` surface — the page has no private protocol of
 * its own, which is exactly why it works over HTTP *and* over the extension
 * bridge without changing a line.
 */
import { createStore, errorMessage } from './dom.js';
import type {
  ChatMessage,
  ConsoleEvent,
  ConsoleTransport,
  HealthRow,
  PluginRow,
  SessionRow,
  SnapshotRow,
  WorkerRow,
} from './types.js';

export interface ConsoleState {
  reachable: boolean;
  lastError?: string;
  /** true while a live frame source (SSE / bridge events) is attached. */
  live: boolean;
  refreshing: boolean;
  health: HealthRow | null;
  workers: WorkerRow[];
  selected?: string;
  plugins: PluginRow[];
  sessions: SessionRow[];
  snapshot: SnapshotRow | null;
  snapshotError?: string;
  /** worker id → chat thread. Threads survive switching workers. */
  threads: Record<string, ChatMessage[]>;
  /** worker id → the task currently generating there. */
  running: Record<string, string | undefined>;
  sending: boolean;
  installing: boolean;
  installNote?: { ok: boolean; text: string };
  log: Array<{ at: number; text: string }>;
}

export interface ConsoleActions {
  store: ReturnType<typeof createStore<ConsoleState>>;
  refresh(): Promise<void>;
  select(worker: string): void;
  loadSnapshot(): Promise<void>;
  send(message: string, options?: { newChat?: boolean; files?: Array<{ name: string; text: string }> }): Promise<void>;
  stop(): Promise<void>;
  newChat(): Promise<void>;
  closeWorker(): Promise<void>;
  openProvider(provider: string): Promise<void>;
  invoke(actionId: string): Promise<void>;
  installManifest(manifest: string, persist: boolean): Promise<void>;
  onEvent(event: ConsoleEvent): void;
  reconnect(): Promise<void>;
  note(text: string): void;
}

let sequence = 0;
const nextId = (): string => `msg-${Date.now().toString(36)}-${++sequence}`;

export function createConsoleState(transport: ConsoleTransport): ConsoleActions {
  const store = createStore<ConsoleState>({
    reachable: false,
    live: false,
    refreshing: false,
    health: null,
    workers: [],
    plugins: [],
    sessions: [],
    snapshot: null,
    threads: {},
    running: {},
    sending: false,
    installing: false,
    log: [],
  });

  const state = () => store.get();

  function log(text: string): void {
    store.update((current) => ({ log: [{ at: Date.now(), text }, ...current.log].slice(0, 200) }));
  }

  function pushMessage(worker: string, message: ChatMessage): void {
    store.update((current) => ({
      threads: { ...current.threads, [worker]: [...(current.threads[worker] ?? []), message] },
    }));
  }

  /** Find (or create) the assistant bubble a task id belongs to. */
  function ensureAssistant(worker: string, taskId?: string): string {
    const existing = taskId ? findMessage(worker, taskId) : undefined;
    if (existing) return existing.id;
    const id = nextId();
    pushMessage(worker, { id, role: 'assistant', text: '', at: Date.now(), streaming: true, taskId });
    return id;
  }

  function patchMessage(worker: string, id: string, patch: Partial<ChatMessage>): void {
    store.update((current) => ({
      threads: {
        ...current.threads,
        [worker]: (current.threads[worker] ?? []).map((message) => (message.id === id ? { ...message, ...patch } : message)),
      },
    }));
  }

  function findMessage(worker: string, taskId: string): ChatMessage | undefined {
    return (state().threads[worker] ?? []).find((message) => message.taskId === taskId && message.role === 'assistant');
  }

  async function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const result = await transport.call<T>(method, params);
      if (!state().reachable) store.set({ reachable: true, lastError: undefined });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      // A method that does not exist means the runtime is older than this page.
      const unreachable = /fetch|network|Failed|not connected|closed|ECONNREFUSED/i.test(message);
      store.set({ reachable: true, lastError: message });
      if (unreachable) store.set({ reachable: false });
      throw error;
    }
  }

  const actions: ConsoleActions = {
    store,

    async refresh() {
      store.set({ refreshing: true });
      try {
        const [health, workers, plugins] = await Promise.all([
          call<HealthRow>('browser_ai_health', {}),
          call<WorkerRow[]>('browser_ai_list_workers', {}),
          call<PluginRow[]>('browser_ai_list_plugins', {}),
        ]);
        const selected = health.workers.some((worker) => worker.id === state().selected)
          ? state().selected
          : workers[0]?.id;
        store.set({
          reachable: true,
          lastError: undefined,
          health,
          workers,
          plugins,
          selected,
          refreshing: false,
          sessions: state().sessions,
        });
        if (!state().live) actions.note('没有实时事件，使用 4s 轮询');
        if (selected && !state().snapshot) await actions.loadSnapshot();
        if (transport.listSessions) {
          const sessions = await transport.listSessions().catch(() => [] as SessionRow[]);
          store.set({ sessions });
        }
      } catch (error) {
        store.set({ refreshing: false, lastError: errorMessage(error) });
      }
    },

    select(worker) {
      store.set({ selected: worker, snapshot: null, snapshotError: undefined });
      void actions.loadSnapshot();
    },

    async loadSnapshot() {
      const worker = state().selected;
      if (!worker) return;
      try {
        const snapshot = await call<SnapshotRow>('browser_ai_snapshot', { worker, transcript: true });
        store.set({ snapshot, snapshotError: undefined });
      } catch (error) {
        store.set({ snapshot: null, snapshotError: errorMessage(error) });
      }
    },

    async send(message, options = {}) {
      const worker = state().selected;
      if (!worker || !message.trim()) return;
      store.set({ sending: true });
      pushMessage(worker, { id: nextId(), role: 'user', text: message, at: Date.now() });
      log(`send_message → ${worker}`);
      let bubble: string | null = null;
      try {
        // Accept first, then wait: the task stays visible in the UI and the
        // streamed text renders while the page is still answering.
        const accepted = await call<{ taskId?: string }>('browser_ai_send_message', {
          worker,
          message,
          wait: false,
          new_chat: options.newChat,
          files: options.files,
        });
        const taskId = accepted.taskId;
        bubble = ensureAssistant(worker, taskId);
        store.update((current) => ({ running: { ...current.running, [worker]: taskId } }));
        const final = await call<{ response: string; durationMs: number; partial?: boolean }>('browser_ai_get_response', {
          worker,
          task_id: taskId,
          wait: true,
        });
        patchMessage(worker, bubble, {
          text: final.response ?? '',
          streaming: false,
          durationMs: final.durationMs,
          note: final.partial ? '答案被提前截断（provider 超时或被停止）' : undefined,
        });
        log(`answered by ${worker} in ${final.durationMs}ms`);
      } catch (error) {
        const detail = errorMessage(error);
        if (bubble) patchMessage(worker, bubble, { streaming: false, note: detail });
        else pushMessage(worker, { id: nextId(), role: 'system', text: detail, at: Date.now(), note: 'send failed' });
        log(`task failed on ${worker}: ${detail}`);
      } finally {
        store.update((current) => ({ sending: false, running: { ...current.running, [worker]: undefined } }));
        void actions.loadSnapshot();
        void actions.refresh();
      }
    },

    async stop() {
      const worker = state().selected;
      if (!worker) return;
      await call('browser_ai_stop_worker', { worker });
      log(`stop_worker ${worker}`);
    },

    async newChat() {
      const worker = state().selected;
      if (!worker) return;
      await call('browser_ai_new_chat', { worker });
      store.update((current) => ({ threads: { ...current.threads, [worker]: [] }, snapshot: null }));
      log(`new_chat ${worker}`);
      void actions.loadSnapshot();
    },

    async closeWorker() {
      const worker = state().selected;
      if (!worker) return;
      await call('browser_ai_close_worker', { worker });
      log(`close_worker ${worker}`);
      store.set({ selected: undefined, snapshot: null });
      await actions.refresh();
    },

    async openProvider(provider) {
      log(`open_worker provider=${provider}`);
      try {
        await call('browser_ai_open_worker', { provider, reuse: true });
        await actions.refresh();
      } catch (error) {
        store.set({ lastError: errorMessage(error) });
        log(`open_worker 失败：${errorMessage(error)}`);
      }
    },

    async invoke(actionId) {
      const worker = state().selected;
      if (!worker) return;
      try {
        await call('browser_ai_invoke_action', { worker, action_id: actionId });
        log(`invoke_action ${worker} ${actionId}`);
        await actions.loadSnapshot();
      } catch (error) {
        store.set({ snapshotError: errorMessage(error) });
      }
    },

    async installManifest(manifest, persist) {
      store.set({ installing: true, installNote: undefined });
      try {
        const descriptor = await call<{ id: string; version: string }>('browser_ai_install_plugin', {
          manifest: JSON.parse(manifest) as Record<string, unknown>,
          persist,
          replace: true,
        });
        store.set({ installNote: { ok: true, text: `已安装 ${descriptor.id} v${descriptor.version}${persist ? '（已写入 plugins/ 目录）' : ''}` } });
        await actions.refresh();
      } catch (error) {
        store.set({ installNote: { ok: false, text: errorMessage(error) } });
      } finally {
        store.set({ installing: false });
      }
    },

    onEvent(event) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      switch (event.kind) {
        case 'stream.open':
          store.set({ live: true });
          return;
        case 'stream.error':
          // No frames means no push channel: fall back to the polling interval.
          store.set({ live: false });
          return;
        case 'worker.added':
        case 'worker.updated': {
          const worker = payload as unknown as WorkerRow;
          if (!worker?.id) return;
          store.update((current) => {
            const others = current.workers.filter((candidate) => candidate.id !== worker.id);
            const workers = [...others, worker].sort((a, b) => a.id.localeCompare(b.id));
            return { workers, selected: current.selected ?? workers[0]?.id };
          });
          return;
        }
        case 'worker.removed': {
          const id = String(payload.id ?? '');
          store.update((current) => ({
            workers: current.workers.filter((worker) => worker.id !== id),
            selected: current.selected === id ? undefined : current.selected,
          }));
          return;
        }
        case 'task.started': {
          const workerId = String(payload.workerId ?? '');
          const taskId = String(payload.taskId ?? '');
          const text = typeof payload.message === 'string' ? payload.message : undefined;
          store.update((current) => {
            const thread = [...(current.threads[workerId] ?? [])];
            // `send()` already put the prompt in the thread; only adopt prompts
            // that came from an agent (MCP) or another tab of this page.
            const alreadyThere = text
              ? thread.some((message) => message.role === 'user' && message.text === text && Date.now() - message.at < 20_000)
              : true;
            if (text && !alreadyThere) thread.push({ id: nextId(), role: 'user', text, at: Date.now() });
            if (!thread.some((message) => message.taskId === taskId && message.role === 'assistant')) {
              thread.push({ id: nextId(), role: 'assistant', text: '', at: Date.now(), streaming: true, taskId });
            }
            return { threads: { ...current.threads, [workerId]: thread }, running: { ...current.running, [workerId]: taskId } };
          });
          log(`task started ${workerId} ${taskId}`);
          return;
        }
        case 'task.progress': {
          const workerId = String(payload.workerId ?? '');
          const taskId = String(payload.taskId ?? '');
          const text = String(payload.text ?? '');
          // Progress frames carry the whole streamed text so far, not a delta.
          const bubble = ensureAssistant(workerId, taskId);
          patchMessage(workerId, bubble, { text, streaming: true });
          return;
        }
        case 'task.completed': {
          const workerId = String(payload.workerId ?? '');
          const taskId = String(payload.taskId ?? '');
          const bubble = ensureAssistant(workerId, taskId);
          patchMessage(workerId, bubble, {
            text: String(payload.response ?? ''),
            streaming: false,
            durationMs: Number(payload.durationMs ?? 0) || undefined,
          });
          store.update((current) => ({ running: { ...current.running, [workerId]: undefined } }));
          log(`task completed ${workerId} in ${payload.durationMs ?? '?'}ms`);
          void actions.loadSnapshot();
          return;
        }
        case 'task.failed': {
          const workerId = String(payload.workerId ?? '');
          const taskId = String(payload.taskId ?? '');
          const error = payload.error as { code?: string; message?: string } | undefined;
          const detail = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? '任务失败'}`;
          const bubble = findMessage(workerId, taskId);
          if (bubble) patchMessage(workerId, bubble.id, { streaming: false, note: detail });
          store.update((current) => ({ running: { ...current.running, [workerId]: undefined } }));
          log(`task failed ${workerId}: ${error?.message ?? 'unknown'}`);
          void actions.refresh();
          return;
        }
        default:
          return;
      }
    },

    async reconnect() {
      if (!transport.reconnect) {
        await actions.refresh();
        return;
      }
      actions.note('正在重新连接 runtime…');
      await transport.reconnect().catch((error: unknown) => store.set({ lastError: errorMessage(error) }));
      await actions.refresh();
    },

    note(text: string) {
      log(text);
    },
  };

  return actions;
}
