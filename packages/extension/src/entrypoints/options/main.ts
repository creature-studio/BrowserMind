/** Options page: runtime connection, plugin catalog, installs, sandbox, diagnostics. */
import { browser } from 'wxt/browser';
import { sendMessage, type ExtensionState } from '../../lib/messaging';
import type { PluginManifest } from '@browsermind/core/browser';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STATUS_DEFAULTS = {
  'runtime-url': '',
};

async function load(): Promise<void> {
  const response = await sendMessage<ExtensionState>({ type: 'state.get' });
  if (!response.ok || !response.data) {
    $('status-text').textContent = `Cannot reach the background worker: ${response.error}`;
    return;
  }
  const state = response.data;
  $<HTMLInputElement>('runtime-url').value = state.runtimeUrl || STATUS_DEFAULTS['runtime-url'];
  const pill = $('status-pill');
  pill.textContent = state.runtimeConnected ? 'connected' : 'offline';
  pill.className = `pill ${state.runtimeConnected ? 'ok' : ''}`;
  $('status-text').textContent = state.runtimeConnected
    ? `${state.workers.length} worker(s): ${state.workers.map((worker) => `${worker.id} (${worker.status})`).join(', ')}`
    : (state.lastError ?? 'Start the runtime with `browsermind serve` and it will connect automatically.');

  $('plugins').innerHTML = state.plugins
    .map(
      (plugin) => `<tr>
        <td><strong>${plugin.id}</strong><div class="muted">${plugin.name} v${plugin.version}</div></td>
        <td class="muted">${plugin.matchPatterns.join('<br>')}</td>
        <td><span class="pill">${plugin.source ?? 'builtin'}</span></td>
        <td>${plugin.granted ? '<span class="pill ok">granted</span>' : '<span class="pill">needs permission</span>'}</td>
      </tr>`,
    )
    .join('');

  const tabs = await browser.tabs.query({});
  $<HTMLSelectElement>('sandbox-tab').innerHTML = tabs
    .filter((tab) => tab.id != null && tab.url && /^https?:/.test(tab.url))
    .map((tab) => `<option value="${tab.id}">${tab.id} — ${(tab.title ?? tab.url ?? '').slice(0, 60)}</option>`)
    .join('');
}

$('save').addEventListener('click', async () => {
  const runtimeUrl = $<HTMLInputElement>('runtime-url').value.trim();
  const result = await sendMessage({ type: 'settings.set', patch: { runtimeUrl } });
  $('status-text').textContent = result.ok ? 'Saved. Reconnecting…' : `Failed: ${result.error}`;
  setTimeout(() => void load(), 1_200);
});

$('status-refresh').addEventListener('click', () => void load());

$('grant').addEventListener('click', async () => {
  const response = await sendMessage<ExtensionState>({ type: 'state.get' });
  const origins = [...new Set((response.data?.plugins ?? []).flatMap((plugin) => plugin.matchPatterns))] as string[];
  const result = await sendMessage({ type: 'plugins.grant', origins });
  $('status-text').textContent = result.ok ? 'Host access granted.' : `Not granted: ${result.error}`;
  void load();
});

function readManifest(): PluginManifest {
  return JSON.parse($<HTMLTextAreaElement>('manifest').value) as PluginManifest;
}

$('install').addEventListener('click', async () => {
  try {
    const manifest = readManifest();
    const result = await sendMessage<{ registered: boolean }>({ type: 'plugins.install', manifest });
    $('install-status').textContent = result.ok
      ? `Installed ${manifest.id}. ${result.data?.registered ? 'Content script active.' : 'Grant host access to activate it.'}`
      : `Failed: ${result.error}`;
    $('install-status').className = `status ${result.ok ? 'ok' : 'err'}`;
    void load();
  } catch (error) {
    $('install-status').textContent = `Invalid manifest: ${String(error)}`;
    $('install-status').className = 'status err';
  }
});

$('install-runtime').addEventListener('click', async () => {
  try {
    const manifest = readManifest();
    const local = await sendMessage({ type: 'plugins.install', manifest });
    if (!local.ok) throw new Error(local.error);
    const remote = await sendMessage({
      type: 'runtime.request',
      method: 'browser_ai_install_plugin',
      params: { manifest, persist: false, replace: true },
    });
    $('install-status').textContent = remote.ok
      ? `Installed ${manifest.id} in the extension and in the runtime.`
      : `Extension OK, runtime failed: ${remote.error} (is the runtime connected?)`;
    $('install-status').className = `status ${remote.ok ? 'ok' : 'err'}`;
    void load();
  } catch (error) {
    $('install-status').textContent = `Invalid manifest: ${String(error)}`;
    $('install-status').className = 'status err';
  }
});

$('sandbox-open').addEventListener('click', () => {
  const tabId = $<HTMLSelectElement>('sandbox-tab').value;
  const pluginId = $<HTMLInputElement>('sandbox-plugin').value.trim();
  const url = browser.runtime.getURL(`/sandbox.html?tab=${tabId}&plugin=${encodeURIComponent(pluginId)}`);
  void browser.tabs.create({ url });
});

$('logs').addEventListener('click', async () => {
  const response = await sendMessage<string[]>({ type: 'logs.get' });
  $('log-output').textContent = (response.data ?? []).join('\n') || 'no logs yet';
});

void load();
