/**
 * Web host of the standalone console page: talks to `browsermind serve` over the
 * documented REST mirror of the MCP tools, plus SSE for live streaming.
 *
 * The page is served by the runtime itself (`/`), so the default target is the
 * same origin. Point it at another runtime with `?runtime=http://host:8787` —
 * the console then works as a purely static page (file://, GitHub Pages, …).
 */
import { mountConsole } from './app.js';
import { h, jsonError } from './dom.js';
import type { ConsoleEvent, ConsoleTransport } from './types.js';

const STORAGE_KEY = 'browsermind.console.base';
const params = new URLSearchParams(location.search);

function readBase(): string {
  const candidate = params.get('runtime') ?? localStorage.getItem(STORAGE_KEY) ?? location.origin;
  return candidate.replace(/\/+$/, '');
}

let base = readBase();

/**
 * One endpoint for every operation: the page only ever names a tool, never a
 * path, so REST paths can be added or renamed without touching this file.
 */
function pathFor(method: string): string {
  return `/api/rpc/${method}`;
}

const listeners = new Set<(event: ConsoleEvent) => void>();
let source: EventSource | null = null;
let live = false;

const SSE_EVENTS = ['hello', 'worker', 'worker.removed', 'task.started', 'task.progress', 'task.completed', 'task.failed'];

/** SSE event name → the worker-manager event it was broadcast from. */
function normalize(kind: string): string {
  return kind === 'worker' ? 'worker.updated' : kind;
}

function openStream(): void {
  source?.close();
  source = new EventSource(`${base}/api/events`);
  source.onopen = () => {
    live = true;
    for (const handler of listeners) handler({ kind: 'stream.open', payload: null });
  };
  source.onerror = () => {
    live = false;
    for (const handler of listeners) handler({ kind: 'stream.error', payload: null });
    // EventSource reconnects by itself; nothing else to do but say so.
  };
  for (const name of SSE_EVENTS) {
    source.addEventListener(name, (event) => {
      const frame = event as MessageEvent<string>;
      let payload: unknown = null;
      try {
        payload = JSON.parse(frame.data) as unknown;
      } catch {
        /* keep-alive comment frames */
      }
      for (const handler of listeners) handler({ kind: normalize(name), payload });
    });
  }
}

const transport: ConsoleTransport = {
  kind: 'web',
  get label() {
    return `Runtime · ${base}`;
  },
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${base}${pathFor(method)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    });
    if (!response.ok) await jsonError(response);
    return (await response.json()) as T;
  },
  subscribe(handler) {
    listeners.add(handler);
    if (!source) openStream();
    return () => {
      listeners.delete(handler);
      if (!listeners.size) {
        source?.close();
        source = null;
      }
    };
  },
  async reconnect() {
    openStream();
    const response = await fetch(`${base}/api/health`, { method: 'GET' });
    if (!response.ok) await jsonError(response);
  },
  openLink(url) {
    window.open(url, '_blank', 'noopener');
  },
};

const root = document.getElementById('app');
if (!root) throw new Error('console: #app is missing from index.html');

mountConsole(root, transport, {
  headerExtra: (actions) => {
    const input = h('input', { class: 'origin', type: 'text', spellcheck: 'false', value: base, placeholder: 'http://127.0.0.1:8787' }) as HTMLInputElement;
    const apply = (): void => {
      base = input.value.trim().replace(/\/+$/, '') || location.origin;
      localStorage.setItem(STORAGE_KEY, base);
      openStream();
      void actions.refresh();
    };
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') apply();
    });
    return h('div', { class: 'origin-row' }, input, h('button', { class: 'ghost', onclick: apply }, '连接'));
  },
  onMount: () => {
    openStream();
  },
});

export { live };
