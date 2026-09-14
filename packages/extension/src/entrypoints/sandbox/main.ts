/**
 * Sandboxed plugin host.
 *
 * Loads a third-party provider plugin (declarative manifest, or adapter source
 * evaluated with `new Function`) inside a CSP sandbox with no extension API
 * access, drives the target page through the tunnelled DOM driver and serves
 * the resulting session to the background.
 *
 * This is what makes Phase 4 (plugin ecosystem) possible without ever letting
 * untrusted code into the user's page or into privileged extension contexts.
 */
import {
  RpcPeer,
  createDeclarativePlugin,
  createLogger,
  createRemoteDomDriver,
  serveSessionProvider,
  type AIAdapter,
  type BrowserAIPlugin,
  type PageSession,
  type PluginContext,
  type PluginManifest,
} from '@browsermind/core/browser';
import { createPortChannel } from '../../lib/port-channel';

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab') ?? '0');
const pluginId = params.get('plugin') ?? '';
const adapterSource = params.get('source') ?? undefined;

const logger = createLogger({ level: 'info', scope: 'sandbox' });
const statusElement = document.getElementById('status')!;
const logElement = document.getElementById('log')!;

function report(message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  statusElement.textContent = message;
  statusElement.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
  logElement.textContent = `${new Date().toLocaleTimeString()} ${message}\n${logElement.textContent}`.slice(0, 4000);
  logger.info(message);
}

/** Evaluate third-party adapter source inside the sandbox only. */
function loadAdapterSource(source: string): BrowserAIPlugin {
  const module = { exports: {} as Record<string, unknown> };
  const factory = new Function('exports', 'module', 'require', source);
  factory(module.exports, module, (name: string) => {
    throw new Error(`Sandboxed plugins cannot require("${name}")`);
  });
  const exports = module.exports as { default?: BrowserAIPlugin; plugin?: BrowserAIPlugin };
  const plugin = exports.default ?? exports.plugin;
  if (!plugin || typeof plugin.createAdapter !== 'function') {
    throw new Error('adapter source must export a BrowserAIPlugin as default/plugin');
  }
  return plugin;
}

async function main(): Promise<void> {
  if (!tabId || !pluginId) {
    report('Missing ?tab=&plugin= parameters — open this page from the BrowserMind options.', 'err');
    return;
  }
  const port = chrome.runtime.connect({ name: 'browsermind/sandbox' });
  const channel = createPortChannel(port as never);
  const peer = new RpcPeer(channel, { name: 'sandbox', timeoutMs: 0 });

  const init = await peer
    .request<{ ok: boolean; sessionId: string; manifest?: PluginManifest }>(
      'sandbox.init',
      { tabId, pluginId, adapterSource },
      20_000,
    )
    .catch((error) => {
      report(`init failed: ${String(error)}`, 'err');
      return null;
    });
  if (!init) return;

  const manifest = init.manifest;
  if (!manifest && !adapterSource) {
    report('The background did not provide a manifest for this plugin.', 'err');
    return;
  }

  const plugin = adapterSource
    ? loadAdapterSource(adapterSource)
    : createDeclarativePlugin(manifest!);

  // DOM access for the sandboxed plugin: every call is tunnelled by the
  // background into the target tab's content script.
  const driver = createRemoteDomDriver(peer, { prefix: 'dom.', location: 'remote' });

  const context: PluginContext = {
    driver,
    logger: logger.child(plugin.id),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const adapter: AIAdapter = plugin.createAdapter(context);
  const session: PageSession = {
    id: init.sessionId,
    pluginId: plugin.id,
    url: init.manifest ? (init as { url?: string }).url ?? '' : '',
    capabilities: plugin.capabilities(),
    location: 'sandbox',
    adapter,
    domDriver: driver,
    close: async () => {
      peer.close();
      port.disconnect();
    },
  };

  serveSessionProvider(peer, {
    list: () => [
      {
        id: session.id,
        pluginId: session.pluginId,
        url: session.url,
        title: `${plugin.name} (sandbox)`,
        capabilities: session.capabilities,
        location: 'sandbox',
      },
    ],
    open: async () => ({
      id: session.id,
      pluginId: session.pluginId,
      url: session.url,
      title: `${plugin.name} (sandbox)`,
      capabilities: session.capabilities,
      location: 'sandbox',
    }),
    getSession: () => session,
    notify: (method, params) => peer.notify(method, params),
  });

  document.title = `BrowserMind sandbox — ${plugin.id}`;
  report(`hosting "${plugin.id}" for tab ${tabId} — session ${init.sessionId}`, 'ok');
}

void main();
