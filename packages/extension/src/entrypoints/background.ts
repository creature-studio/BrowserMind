/**
 * Background service worker.
 *
 * Responsibilities (and nothing else):
 *   - own the plugin registry built from `plugins/`,
 *   - keep the WebSocket to the runtime alive (see `RuntimeBridge`),
 *   - turn matching tabs into sessions (`TabManager`),
 *   - answer popup/options requests.
 *
 * DOM work never happens here: it belongs to the content script (or, for
 * untrusted third-party plugins, to the sandbox page).
 */
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  PluginRegistry,
  createLogger,
  type PluginManifest,
  type WorkerDescriptor,
} from '@browsermind/core/browser';
import { builtinPlugins } from '../generated/plugin-modules';
import { TabManager } from '../lib/tab-manager';
import { RuntimeBridge } from '../lib/runtime-bridge';
import { getSettings, setSettings } from '../lib/settings';
import type { ExtensionMessage, ExtensionState, MessageResponse } from '../lib/messaging';

const logger = createLogger({ level: 'info', scope: 'bg' });

export default defineBackground(() => {
  const registry = new PluginRegistry();
  for (const plugin of builtinPlugins()) {
    registry.register(plugin, { source: 'builtin' });
  }

  const tabs = new TabManager(
    (url) => registry.findPlugin(url),
    () => registry.list(),
    logger.child('tabs'),
  );
  const bridge = new RuntimeBridge(tabs, logger.child('bridge'));
  const recentLogs: string[] = [];
  const pushLog = (line: string) => {
    recentLogs.unshift(`${new Date().toISOString()} ${line}`);
    recentLogs.length = Math.min(recentLogs.length, 80);
  };

  tabs.onChange = () => pushLog(`sessions: ${tabs.list().map((session) => `${session.id}:${session.pluginId}`).join(', ')}`);

  /* ------------------------------- boot ------------------------------- */

  void (async () => {
    const settings = await getSettings();
    logger.info('BrowserMind background started', { plugins: registry.list().map((plugin) => plugin.id) });
    // Runtime-installed plugins survive a browser restart: re-register them.
    const manifests = Object.values(settings.installedManifests ?? {}) as PluginManifest[];
    for (const manifest of manifests) {
      await tabs.registerContentScript(manifest);
    }
    await tabs.attachExistingTabs();
    await bridge.connect();
  })();

  /* --------------------------- tab lifecycle -------------------------- */

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      // SPA navigation keeps the content script, a full load re-announces itself.
      const tracked = tabs.sessionForTab(tabId);
      if (tracked) {
        tracked.url = changeInfo.url;
        tracked.session.url = changeInfo.url;
      }
    }
    if (changeInfo.status === 'complete' && tab.url && registry.findPlugin(tab.url)) {
      void browser.tabs.sendMessage(tabId, { type: 'browsermind/ping' }).catch(() => undefined);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => tabs.detachTab(tabId, 'tab-closed'));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'browsermind/page') {
      void tabs.handleContentPort(port as never);
      return;
    }
    if (port.name === 'browsermind/sandbox') {
      void import('../lib/sandbox-host').then(({ handleSandboxPort }) => handleSandboxPort(port as never, tabs, logger.child('sandbox')));
      return;
    }
    logger.debug('unknown port', { name: port.name });
  });

  /* ---------------------------- keepalive ----------------------------- */

  // MV3 service workers are evicted when idle; recreating the connection on
  // wake (and on a slow alarm) keeps the runtime link up without a page.
  browser.alarms?.create?.('browsermind-keepalive', { periodInMinutes: 1 });
  browser.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name !== 'browsermind-keepalive') return;
    if (!bridge.connected) void bridge.connect();
  });

  /* ------------------------------ messages ---------------------------- */

  async function buildState(): Promise<ExtensionState> {
    const settings = await getSettings();
    const plugins = [
      ...registry.list().map((descriptor) => ({ descriptor, installed: false })),
      ...Object.values(settings.installedManifests ?? {}).map((manifest) => {
        const typed = manifest as PluginManifest;
        return {
          descriptor: {
            id: typed.id,
            name: typed.name,
            version: typed.version,
            matchPatterns: typed.matchPatterns ?? [],
            capabilities: typed.capabilities ?? [],
            source: 'remote' as const,
          },
          installed: true,
        };
      }),
    ];
    const origins = [...new Set(plugins.flatMap((entry) => entry.descriptor.matchPatterns))];
    const granted = origins.length
      ? await browser.permissions.contains({ origins }).catch(() => false)
      : true;
    return {
      runtimeUrl: settings.runtimeUrl,
      runtimeConnected: bridge.connected,
      lastError: bridge.lastError,
      workers: bridge.workerSnapshot as WorkerDescriptor[],
      sessions: tabs.list().map((session) => ({
        id: session.id,
        pluginId: session.pluginId,
        url: session.url,
        title: session.title,
        tabId: session.tabId,
        location: session.location,
        attached: !session.detached,
      })),
      plugins: plugins.map((entry) => ({
        id: entry.descriptor.id,
        name: entry.descriptor.name,
        version: entry.descriptor.version,
        matchPatterns: entry.descriptor.matchPatterns,
        source: entry.descriptor.source,
        granted,
      })),
    };
  }

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      const request = message as ExtensionMessage;
      try {
        switch (request.type) {
          case 'state.get':
            sendResponse({ ok: true, data: await buildState() } satisfies MessageResponse<ExtensionState>);
            return;
          case 'logs.get':
            sendResponse({ ok: true, data: recentLogs } satisfies MessageResponse<string[]>);
            return;
          case 'runtime.request': {
            // Anything the popup/options want from the runtime (workers,
            // snapshots, send_message…) goes through the same RPC channel the
            // runtime itself serves to MCP.
            const data = await bridge.request(request.method, request.params, 180_000);
            sendResponse({ ok: true, data } satisfies MessageResponse);
            return;
          }
          case 'runtime.reconnect':
            await bridge.reconnect();
            sendResponse({ ok: true, data: { connected: bridge.connected } } satisfies MessageResponse);
            return;
          case 'settings.set': {
            const settings = await setSettings(request.patch as never);
            if (request.patch.runtimeUrl) await bridge.reconnect();
            sendResponse({ ok: true, data: settings } satisfies MessageResponse);
            return;
          }
          case 'tabs.open': {
            const opened = await tabs.openTab({
              provider: request.provider,
              url: request.url,
              active: true,
            });
            const session = await tabs.waitForSession(opened.tabId, 20_000);
            sendResponse({
              ok: Boolean(session),
              data: { tabId: opened.tabId, url: opened.url, sessionId: session?.id, pluginId: session?.pluginId },
              error: session ? undefined : 'The page did not report a plugin (still loading?)',
            } satisfies MessageResponse);
            return;
          }
          case 'tabs.close':
            await browser.tabs.remove(request.tabId);
            tabs.detachTab(request.tabId, 'closed-by-user');
            sendResponse({ ok: true } satisfies MessageResponse);
            return;
          case 'tabs.focus':
            await browser.tabs.update(request.tabId, { active: true });
            sendResponse({ ok: true } satisfies MessageResponse);
            return;
          case 'tabs.highlight':
            await browser.tabs.sendMessage(request.tabId, { type: 'browsermind/highlight' }).catch(() => undefined);
            sendResponse({ ok: true } satisfies MessageResponse);
            return;
          case 'plugins.grant': {
            const granted = await browser.permissions.request({ origins: request.origins as `${string}/*`[] });
            if (granted) {
              const settings = await getSettings();
              for (const manifest of Object.values(settings.installedManifests ?? {}) as PluginManifest[]) {
                await tabs.registerContentScript(manifest);
              }
            }
            sendResponse({ ok: granted, error: granted ? undefined : 'Permission denied' } satisfies MessageResponse);
            return;
          }
          case 'plugins.install': {
            const manifest = request.manifest;
            const settings = await getSettings();
            const installed = { ...(settings.installedManifests ?? {}), [manifest.id]: manifest };
            await setSettings({ installedManifests: installed });
            const registered = await tabs.registerContentScript(manifest);
            pushLog(`plugin installed locally: ${manifest.id} (content script: ${registered ? 'active' : 'pending permission'})`);
            sendResponse({
              ok: true,
              data: { id: manifest.id, registered },
              error: registered ? undefined : 'Grant host permission for the pattern to activate this plugin',
            } satisfies MessageResponse);
            return;
          }
          case 'plugins.remove': {
            const settings = await getSettings();
            const installed = { ...(settings.installedManifests ?? {}) };
            delete installed[request.id];
            await setSettings({ installedManifests: installed });
            await browser.scripting.unregisterContentScripts({ ids: [`browsermind-plugin-${request.id}`] }).catch(() => undefined);
            sendResponse({ ok: true } satisfies MessageResponse);
            return;
          }
          default:
            sendResponse({ ok: false, error: `Unknown message: ${(request as { type?: string }).type}` } satisfies MessageResponse);
        }
      } catch (error) {
        logger.error('message failed', { type: (message as { type?: string })?.type, error: String(error) });
        sendResponse({ ok: false, error: String(error) } satisfies MessageResponse);
      }
    })();
    return true; // keep the message channel open for the async reply
  });
});
