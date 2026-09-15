/**
 * Extension host of the standalone console.
 *
 * Same page as `packages/console` (identical markup, identical state machine), only
 * the transport differs: instead of REST + SSE it uses the background worker's RPC
 * (`runtime.request` → the runtime's `browser_ai.*` table) and the relayed task
 * frames. That means the console works even when nobody opened the HTTP port, and
 * it can do the tab-level things only an extension may do (focus / close a page).
 */
import { browser } from 'wxt/browser';
import '@browsermind/console/styles.css';
import { h, mountConsole } from '@browsermind/console/mount';
import type { ConsoleTransport, SessionRow } from '@browsermind/console/types';
import { sendMessage, type ExtensionState } from '../../lib/messaging';

const transport: ConsoleTransport = {
  kind: 'extension',
  label: '扩展 ⇄ runtime RPC',

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await sendMessage<T>({ type: 'runtime.request', method, params });
    if (!response.ok) throw new Error(response.error ?? `${method} failed`);
    return response.data as T;
  },

  subscribe(handler) {
    const listener = (message: unknown): void => {
      const event = message as { type?: string; event?: { kind: string; payload: unknown } };
      if (event?.type !== 'browsermind/event' || !event.event) return;
      handler(event.event);
    };
    browser.runtime.onMessage.addListener(listener);
    void handler({ kind: 'stream.open', payload: null });
    return () => browser.runtime.onMessage.removeListener(listener);
  },

  async reconnect() {
    const result = await sendMessage<{ connected: boolean }>({ type: 'runtime.reconnect' });
    if (!result.ok) throw new Error(result.error ?? 'reconnect failed');
  },

  async listSessions() {
    const response = await sendMessage<ExtensionState>({ type: 'state.get' });
    return (response.data?.sessions ?? []) as SessionRow[];
  },

  async tabAction(action, tabId) {
    if (!Number.isFinite(tabId)) return;
    if (action === 'close') await sendMessage({ type: 'tabs.close', tabId });
    else if (action === 'focus') await sendMessage({ type: 'tabs.focus', tabId });
    else await sendMessage({ type: 'tabs.highlight', tabId });
  },

  openLink(url) {
    void browser.tabs.create({ url, active: true });
  },
};

const root = document.getElementById('app');
if (!root) throw new Error('console: #app is missing from console/index.html');

mountConsole(root, transport, {
  headerExtra: () =>
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'ghost', onclick: () => void browser.runtime.openOptionsPage() }, '设置 / 插件授权'),
    ),
});
