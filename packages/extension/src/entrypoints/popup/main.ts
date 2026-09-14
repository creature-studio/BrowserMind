/** Popup: the human's view of the worker runtime. */
import { browser } from 'wxt/browser';
import { sendMessage, type ExtensionState } from '../../lib/messaging';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let state: ExtensionState | null = null;
let selectedWorker: string | null = null;

async function refresh(): Promise<void> {
  const response = await sendMessage<ExtensionState>({ type: 'state.get' });
  if (!response.ok || !response.data) {
    $('bridge').textContent = `error: ${response.error}`;
    return;
  }
  state = response.data;
  $('dot').className = `dot ${state.runtimeConnected ? 'on' : ''}`;
  $('bridge').textContent = state.runtimeConnected
    ? `runtime: connected`
    : `runtime: ${state.lastError ?? 'not connected'}`;

  const workers = state.workers ?? [];
  $('workers').innerHTML =
    workers.length === 0
      ? '<div class="empty">No workers yet. Open a provider tab below, or start the runtime with <code>--simulate</code>.</div>'
      : workers
          .map(
            (worker) => `
        <div class="card">
          <div class="row">
            <input type="radio" name="worker" value="${worker.id}" ${worker.id === selectedWorker ? 'checked' : ''} />
            <strong>${worker.id}</strong>
            <span class="pill ${worker.status}">${worker.status}</span>
            <span class="muted">${worker.provider}</span>
          </div>
          <div class="muted">${(worker.capabilities ?? []).join(' · ')}</div>
          <div class="muted">${worker.url ?? ''}</div>
        </div>`,
          )
          .join('');

  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="worker"]'))) {
    input.addEventListener('change', () => {
      selectedWorker = input.value;
    });
  }
  if (!selectedWorker && workers[0]) selectedWorker = workers[0].id;

  const sessions = state.sessions ?? [];
  $('sessions').innerHTML =
    sessions.length === 0
      ? '<div class="empty">No page is attached. Open a supported AI chat tab.</div>'
      : sessions
          .map(
            (session) => `
        <div class="card">
          <div class="row">
            <strong>${session.pluginId}</strong>
            <span class="pill">${session.location}</span>
            <span class="muted">tab ${session.tabId}</span>
          </div>
          <div class="muted">${session.title ?? ''} — ${session.url}</div>
          <div class="row" style="margin-top:4px">
            <button data-focus="${session.tabId}">Focus</button>
            <button data-close="${session.tabId}">Close</button>
          </div>
        </div>`,
          )
          .join('');

  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-focus]'))) {
    button.addEventListener('click', () => void sendMessage({ type: 'tabs.focus', tabId: Number(button.dataset.focus) }));
  }
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-close]'))) {
    button.addEventListener('click', async () => {
      await sendMessage({ type: 'tabs.close', tabId: Number(button.dataset.close) });
      void refresh();
    });
  }

  const providers = [...new Set((state.plugins ?? []).filter((plugin) => plugin.id !== 'mock').map((plugin) => plugin.id))];
  $('providers').innerHTML = providers.map((id) => `<button data-provider="${id}">${id}</button>`).join('');
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-provider]'))) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await sendMessage({ type: 'tabs.open', provider: button.dataset.provider });
      button.disabled = false;
      if (!result.ok) {
        $('answer').hidden = false;
        $('answer').textContent = `Could not open ${button.dataset.provider}: ${result.error}`;
      }
      setTimeout(() => void refresh(), 1_500);
    });
  }
}

$('reconnect').addEventListener('click', async () => {
  $('bridge').textContent = 'runtime: connecting…';
  await sendMessage({ type: 'runtime.reconnect' });
  setTimeout(() => void refresh(), 800);
});

$('send').addEventListener('click', async () => {
  const message = $<HTMLTextAreaElement>('message').value.trim();
  if (!message || !selectedWorker || !state) return;
  const button = $<HTMLButtonElement>('send');
  button.disabled = true;
  $('answer').hidden = false;
  $('answer').textContent = '…';
  try {
    // The popup is just another client of the runtime: same RPC surface the
    // MCP server exposes to agents, routed through the background.
    const result = await sendMessage<{ response?: string; durationMs?: number; taskId?: string }>({
      type: 'runtime.request',
      method: 'browser_ai_send_message',
      params: { worker: selectedWorker, message, wait: false },
    });
    if (!result.ok) throw new Error(result.error ?? 'send failed');
    const taskId = result.data?.taskId;
    $('answer').textContent = `accepted (${taskId ?? 'task'}) — waiting for the answer…`;
    const answer = await sendMessage<{ response?: string }>({
      type: 'runtime.request',
      method: 'browser_ai_get_response',
      params: { worker: selectedWorker, task_id: taskId, wait: true },
    });
    $('answer').textContent = answer.ok ? (answer.data?.response ?? '(empty answer)') : `error: ${answer.error}`;
  } catch (error) {
    $('answer').textContent = `error: ${String(error)}`;
  } finally {
    button.disabled = false;
  }
});

$('highlight').addEventListener('click', async () => {
  const session = state?.sessions.find((candidate) => candidate.id.startsWith(selectedWorker ?? ''));
  const tabId = session?.tabId ?? state?.sessions[0]?.tabId;
  if (tabId) await browser.tabs.sendMessage(tabId, { type: 'browsermind/highlight' });
});

$('options').addEventListener('click', () => browser.runtime.openOptionsPage());
$('reload-all').addEventListener('click', () => void refresh());

void refresh();
setInterval(() => void refresh(), 2_000);
