/**
 * Content script — the page agent.
 *
 * Runs inside a chat page, instantiates the matching plugin adapter (the plugin
 * needs no DOM access outside this script) and serves that page to the
 * background worker over a `chrome.runtime.Port`, using the very same protocol
 * the background uses towards the runtime:
 *
 *   runtime ⇄ background ⇄ content script ⇄ DOM
 *
 * Everything is `DomDriver` based, so a sandboxed third-party plugin on the
 * other side of the wire drives the page through the exact same interface.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  PluginRegistry,
  RpcPeer,
  createDomDriverFromWindow,
  createLocalDomDriver,
  createLogger,
  createPlugin,
  createDeclarativePlugin,
  serveSessionProvider,
  type AIAdapter,
  type BrowserAIPlugin,
  type Logger,
  type PageSession,
  type PluginContext,
  type PluginManifest,
  type SessionInfo,
} from '@browsermind/core/browser';
import { builtinPlugins } from '../generated/plugin-modules';
import { PLUGIN_MATCH_PATTERNS } from '../generated/plugin-manifests';
import { createPortChannel } from '../lib/port-channel';
import { getSettings } from '../lib/settings';

export interface AttachPayload {
  sessionId: string;
  /** Manifest of a plugin installed on the runtime side (optional). */
  manifest?: PluginManifest;
}

function createRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of builtinPlugins()) registry.register(plugin, { source: 'builtin' });
  return registry;
}

export default defineContentScript({
  // Built from the plugin folders, so adding a provider widens the manifest
  // automatically. Plugins installed *at runtime* are injected by the
  // background through `chrome.scripting.registerContentScripts` instead.
  matches: PLUGIN_MATCH_PATTERNS as string[],
  runAt: 'document_idle',
  allFrames: false,
  async main() {
    const logger = createLogger({ level: 'info', scope: `page:${location.host}` });
    const driver = createDomDriverFromWindow(window);
    const registry = createRegistry();
    let session: PageSession | null = null;

    const port = browser.runtime.connect({ name: 'browsermind/page' });
    const channel = createPortChannel(port as unknown as PortLike);
    const peer = new RpcPeer(channel, {
      name: 'content',
      timeoutMs: 0,
      handlers: {
        'page.ping': () => ({ ok: true, url: location.href, title: document.title }),
        'page.attach': async (payload: AttachPayload) => {
          session = await attach(payload);
          return {
            id: session.id,
            url: session.url,
            title: session.title,
            pluginId: session.pluginId,
            capabilities: session.capabilities,
          };
        },
        'page.highlight': async () => {
          // Small affordance for the popup: outline the composer so the user
          // can see which element the plugin is driving.
          const composer = document.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
          if (!composer) return { ok: false };
          const previous = composer.style.outline;
          composer.style.outline = '2px solid #6d8cff';
          setTimeout(() => {
            composer.style.outline = previous;
          }, 1200);
          return { ok: true };
        },
      },
    });

    async function attach(payload: AttachPayload): Promise<PageSession> {
      const settings = await getSettings();
      const plugin = payload.manifest
        ? createDeclarativePlugin(payload.manifest)
        : registry.findPlugin(location.href);
      if (!plugin) {
        throw new Error(
          `No BrowserMind plugin matches ${location.href}. Install a provider plugin for this site.`,
        );
      }
      const context: PluginContext = {
        driver,
        logger: logger.child(plugin.id),
        now: () => Date.now(),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        config: { settings: { autoFocus: settings.autoFocusComposer } },
      };
      const adapter: AIAdapter = plugin.createAdapter(context);
      return {
        id: payload.sessionId,
        pluginId: plugin.id,
        url: location.href,
        title: document.title,
        capabilities: plugin.capabilities(),
        location: 'page',
        adapter,
        domDriver: driver,
        close: async () => {
          peer.close();
          port.disconnect();
        },
      };
    }

    // The background drives *this page* through the shared session protocol:
    // the content script is simply a provider of exactly one session.
    serveSessionProvider(peer, {
      list: () => (session ? [toInfo(session)] : []),
      open: async () => {
        if (!session) session = await attach({ sessionId: `page-${Date.now().toString(36)}` });
        return toInfo(session);
      },
      getSession: (id) => (session && session.id === id ? session : undefined),
      close: async () => {
        port.disconnect();
      },
      focus: async () => {
        window.focus();
      },
      heartbeat: async () => ({ at: Date.now(), url: location.href }),
      notify: (method, params) => peer.notify(method, params),
    });

    peer.notify('page.ready', {
      url: location.href,
      title: document.title,
      matchingPlugins: registry.list().filter((descriptor) => descriptor.matchPatterns.some(() => true)).map((d) => d.id),
      plugin: registry.findPlugin(location.href)?.id ?? null,
    });

    const reportUrlChange = () => peer.notify('page.navigated', { url: location.href, title: document.title });
    window.addEventListener('popstate', reportUrlChange);
    // Chat sites are SPAs: watch for history changes without leaking listeners.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        reportUrlChange();
      }
    }, 2_000);
  },
});

function toInfo(session: PageSession): SessionInfo {
  return {
    id: session.id,
    pluginId: session.pluginId,
    url: session.url,
    title: session.title,
    capabilities: session.capabilities,
    location: 'page',
  };
}

interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  disconnect(): void;
}

export { createRegistry, createPlugin, createLogger, createLocalDomDriver, type Logger, type BrowserAIPlugin };
