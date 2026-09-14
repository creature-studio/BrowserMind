/**
 * Tab manager — the bridge between Chrome tabs and Browser AI Workers.
 *
 * For every tab whose URL matches an installed plugin it
 *
 *   1. receives the content script's port (`browsermind/page`),
 *   2. makes the content script build the plugin adapter (`page.attach`),
 *   3. exposes the resulting page session through the *core* session protocol,
 *      which the runtime consumes exactly like its own simulator.
 *
 * As a result the runtime cannot tell (and does not care) whether a worker is
 * backed by a real Chrome tab, a jsdom page or a sandboxed third-party plugin.
 */
import { browser } from 'wxt/browser';
import {
  RpcPeer,
  createDeclarativePlugin,
  createLogger,
  createRemoteAdapter,
  createSessionDomDriver,
  matchUrlPattern,
  serveSessionProvider,
  type BrowserAIPlugin,
  type Logger,
  type PageSession,
  type PluginDescriptor,
  type PluginManifest,
  type SessionInfo,
} from '@browsermind/core/browser';
import { createPortChannel, type PortLike } from './port-channel';
import { getSettings, setSettings } from './settings';

export interface TrackedSession {
  id: string;
  tabId: number;
  pluginId: string;
  pluginName: string;
  url: string;
  title?: string;
  capabilities: string[];
  location: 'page' | 'sandbox';
  peer: RpcPeer;
  session: PageSession;
  detached: boolean;
}

interface PendingPort {
  tabId: number;
  peer: RpcPeer;
  port: PortLike;
}

export class TabManager {
  readonly logger: Logger;
  readonly sessions = new Map<string, TrackedSession>();
  /** Called whenever the session inventory changes (popup refresh, runtime push). */
  onChange: ((sessions: TrackedSession[]) => void) | null = null;
  #peersByTab = new Map<number, PendingPort>();

  constructor(
    private readonly resolvePlugin: (url: string) => BrowserAIPlugin | null,
    private readonly listPlugins: () => PluginDescriptor[],
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ level: 'info', scope: 'tabs' });
  }

  /* ------------------------------------------------------------------ */
  /* Content-script ports                                                */
  /* ------------------------------------------------------------------ */

  /** Handle a `chrome.runtime.onConnect` port coming from a chat page. */
  async handleContentPort(port: PortLike & { sender?: { tab?: { id?: number } } }): Promise<TrackedSession | null> {
    const tabId = (port as unknown as { sender?: { tab?: { id?: number } } }).sender?.tab?.id;
    if (typeof tabId !== 'number') {
      this.logger.warn('content port without a tab id — ignored');
      return null;
    }
    const channel = createPortChannel(port);
    const peer = new RpcPeer(channel, { name: `content:${tabId}`, timeoutMs: 0 });
    this.#peersByTab.set(tabId, { tabId, peer, port });

    channel.onClose?.(() => {
      this.logger.info('content port closed', { tabId });
      this.detachTab(tabId, 'port-closed');
    });

    peer.onEvent((event) => {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const tracked = [...this.sessions.values()].find((session) => session.tabId === tabId);
      switch (event.method) {
        case 'page.ready':
          void this.#attachTab(tabId, peer, typeof params.url === 'string' ? params.url : undefined);
          return;
        case 'page.navigated':
          if (!tracked) return;
          tracked.url = String(params.url ?? tracked.url);
          tracked.title = params.title ? String(params.title) : tracked.title;
          tracked.session.url = tracked.url;
          tracked.session.title = tracked.title;
          this.#notify();
          return;
        default:
          return;
      }
    });

    // Content scripts announce themselves; if the message crossed a service
    // worker restart, ask directly instead.
    const pong = await peer.request<{ url: string }>('page.ping', {}, 4_000).catch(() => null);
    if (pong && !this.sessions.has(`page-${tabId}`)) {
      await this.#attachTab(tabId, peer, pong.url);
    }
    return [...this.sessions.values()].find((session) => session.tabId === tabId) ?? null;
  }

  async #attachTab(tabId: number, peer: RpcPeer, url?: string): Promise<TrackedSession | null> {
    const existing = [...this.sessions.values()].find((session) => session.tabId === tabId && !session.detached);
    if (existing) return existing;

    const tab = await browser.tabs.get(tabId).catch(() => null);
    const targetUrl = url ?? tab?.url ?? '';
    const settings = await getSettings();
    const installedManifest = Object.values(settings.installedManifests ?? {}).find((candidate) => {
      const manifest = candidate as PluginManifest;
      return manifest?.matchPatterns?.some((pattern) => matchUrlPattern(pattern, targetUrl));
    }) as PluginManifest | undefined;

    const plugin = installedManifest ? createDeclarativePlugin(installedManifest) : this.resolvePlugin(targetUrl);
    if (!plugin) {
      this.logger.debug('no plugin for tab', { tabId, url: targetUrl });
      return null;
    }

    const sessionId = `page-${tabId}`;
    const attached = await peer
      .request<{ id: string; capabilities: string[] }>('page.attach', { sessionId, manifest: installedManifest })
      .catch((error) => {
        this.logger.warn('page.attach failed', { tabId, error: String(error) });
        return null;
      });
    if (!attached) return null;

    const tracked = this.#buildSession({
      id: sessionId,
      tabId,
      peer,
      pluginId: plugin.id,
      pluginName: plugin.name,
      url: targetUrl,
      title: tab?.title,
      capabilities: plugin.capabilities(),
      location: 'page',
    });
    this.logger.info('page attached', { tabId, plugin: plugin.id, url: targetUrl });
    return tracked;
  }

  #buildSession(input: {
    id: string;
    tabId: number;
    peer: RpcPeer;
    pluginId: string;
    pluginName: string;
    url: string;
    title?: string;
    capabilities: string[];
    location: 'page' | 'sandbox';
  }): TrackedSession {
    const tabId = input.tabId;
    const session: PageSession = {
      id: input.id,
      pluginId: input.pluginId,
      url: input.url,
      title: input.title,
      tabId,
      capabilities: input.capabilities,
      location: input.location,
      adapter: createRemoteAdapter(input.peer, input.id, input.pluginId),
      domDriver: createSessionDomDriver(input.peer, input.id),
      close: async () => {
        await browser.tabs.remove(tabId).catch(() => undefined);
      },
      navigate: async (url: string) => {
        await browser.tabs.update(tabId, { url });
      },
      reload: async () => {
        await browser.tabs.reload(tabId);
      },
      focus: async () => {
        await browser.tabs.update(tabId, { active: true });
      },
    };
    const tracked: TrackedSession = {
      id: input.id,
      tabId,
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      url: input.url,
      title: input.title,
      capabilities: input.capabilities,
      location: input.location,
      peer: input.peer,
      session,
      detached: false,
    };
    this.sessions.set(input.id, tracked);
    this.#notify();
    return tracked;
  }

  /** Register a session whose adapter runs in the sandbox page, not in the page. */
  registerSandboxSession(input: {
    id: string;
    tabId: number;
    peer: RpcPeer;
    pluginId: string;
    pluginName: string;
    url: string;
    capabilities: string[];
  }): TrackedSession {
    const tracked = this.#buildSession({ ...input, location: 'sandbox' });
    this.logger.info('sandbox session registered', { id: input.id, plugin: input.pluginId });
    return tracked;
  }

  detachTab(tabId: number, reason = 'detached'): void {
    for (const [id, tracked] of [...this.sessions]) {
      if (tracked.tabId !== tabId) continue;
      tracked.detached = true;
      this.sessions.delete(id);
      this.logger.info('session detached', { id, reason });
    }
    this.#peersByTab.delete(tabId);
    this.#notify();
  }

  get(sessionId: string): TrackedSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): TrackedSession[] {
    return [...this.sessions.values()];
  }

  sessionForTab(tabId: number): TrackedSession | undefined {
    return this.list().find((session) => session.tabId === tabId);
  }

  sessionInfos(): SessionInfo[] {
    return this.list().map((session) => ({
      id: session.id,
      pluginId: session.pluginId,
      url: session.url,
      title: session.title,
      tabId: session.tabId,
      capabilities: session.capabilities,
      location: session.location,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Tabs ↔ sessions                                                     */
  /* ------------------------------------------------------------------ */

  /** Ask every already-open matching tab to announce its plugin. */
  async attachExistingTabs(): Promise<void> {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || !tab.url) continue;
      if (!this.resolvePlugin(tab.url)) continue;
      await browser.tabs.sendMessage(tab.id, { type: 'browsermind/ping' }).catch(() => undefined);
    }
  }

  /** Open (or focus) a provider page. */
  async openTab(request: { provider?: string; url?: string; active?: boolean }): Promise<{ tabId: number; url: string }> {
    let url = request.url;
    if (!url && request.provider) {
      const descriptor = this.listPlugins().find((plugin) => plugin.id === request.provider);
      if (!descriptor) throw new Error(`Unknown provider "${request.provider}"`);
      url = sampleUrlFor(descriptor.matchPatterns);
    }
    if (!url) throw new Error('openTab requires a provider or a url');

    const existing = (await browser.tabs.query({})).find((tab) => tab.url && sameOrigin(tab.url, url!));
    if (existing?.id) {
      await browser.tabs.update(existing.id, { active: request.active ?? true });
      return { tabId: existing.id, url: existing.url ?? url };
    }
    const created = await browser.tabs.create({ url, active: request.active ?? true });
    return { tabId: created.id!, url: created.url ?? url };
  }

  /** Wait until a tab's session becomes available. */
  async waitForSession(tabId: number, timeoutMs = 25_000): Promise<TrackedSession | null> {
    const started = Date.now();
    for (;;) {
      const found = this.sessionForTab(tabId);
      if (found) return found;
      if (Date.now() - started > timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  pluginFor(url: string): BrowserAIPlugin | null {
    return this.resolvePlugin(url);
  }

  /** The content-script peer of a tab — used to tunnel DOM calls into the page. */
  contentPeerFor(tabId: number): RpcPeer | undefined {
    return this.#peersByTab.get(tabId)?.peer;
  }

  /* ------------------------------------------------------------------ */
  /* Runtime-facing protocol server                                      */
  /* ------------------------------------------------------------------ */

  serve(peer: RpcPeer, options: { heartbeat?: () => Promise<unknown> } = {}): void {
    serveSessionProvider(peer, {
      list: () => this.sessionInfos(),
      open: async (request) => {
        const opened = await this.openTab({
          provider: request.provider,
          url: request.url,
          active: request.active ?? false,
        });
        const session = await this.waitForSession(opened.tabId);
        if (!session) {
          throw new Error(
            `Tab ${opened.tabId} (${opened.url}) did not report a BrowserMind plugin. ` +
              'Is the page loaded and does an installed plugin match this URL?',
          );
        }
        return {
          id: session.id,
          pluginId: session.pluginId,
          url: session.url,
          title: session.title,
          tabId: session.tabId,
          capabilities: session.capabilities,
          location: session.location,
        };
      },
      getSession: (sessionId) => this.sessions.get(sessionId)?.session,
      close: async (sessionId) => {
        const tracked = this.sessions.get(sessionId);
        if (!tracked) return;
        await browser.tabs.remove(tracked.tabId).catch(() => undefined);
        this.detachTab(tracked.tabId, 'closed-by-runtime');
      },
      navigate: async (sessionId, url) => {
        const tracked = this.sessions.get(sessionId);
        if (tracked) await browser.tabs.update(tracked.tabId, { url });
      },
      reload: async (sessionId) => {
        const tracked = this.sessions.get(sessionId);
        if (tracked) await browser.tabs.reload(tracked.tabId);
      },
      focus: async (sessionId) => {
        const tracked = this.sessions.get(sessionId);
        if (tracked) await browser.tabs.update(tracked.tabId, { active: true });
      },
      heartbeat: options.heartbeat,
      notify: (method, params) => peer.notify(method, params),
    });
  }

  /** Mirror the runtime's plugin catalog so runtime-installed plugins work here too. */
  async syncInstalledManifests(manifests: PluginManifest[]): Promise<string[]> {
    const settings = await getSettings();
    const installed: Record<string, unknown> = { ...(settings.installedManifests ?? {}) };
    const registered: string[] = [];
    for (const manifest of manifests) {
      if (!manifest?.id || !Array.isArray(manifest.matchPatterns)) continue;
      installed[manifest.id] = manifest;
      const patterns = manifest.matchPatterns;
      const granted = await browser.permissions.contains({ origins: patterns }).catch(() => false);
      if (granted && (await this.registerContentScript(manifest))) registered.push(manifest.id);
    }
    await setSettings({ installedManifests: installed });
    return registered;
  }

  /**
   * Register the (already bundled) content script for a runtime-installed
   * plugin. Chrome only injects it when the user has granted the origins.
   */
  async registerContentScript(manifest: PluginManifest): Promise<boolean> {
    const patterns = manifest.matchPatterns ?? [];
    if (!patterns.length) return false;
    const id = `browsermind-plugin-${manifest.id}`;
    try {
      await browser.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined);
      await browser.scripting.registerContentScripts([
        {
          id,
          js: ['content-scripts/content.js'],
          matches: patterns,
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ]);
      this.logger.info('dynamic content script registered', { id, patterns });
      return true;
    } catch (error) {
      this.logger.error('failed to register content script', { id, error: String(error) });
      return false;
    }
  }

  #notify(): void {
    this.onChange?.(this.list());
  }
}

/** `https://chat.deepseek.com/*` → `https://chat.deepseek.com/` */
export function sampleUrlFor(patterns: string[]): string {
  const pattern = patterns[0] ?? 'https://example.com/*';
  return pattern
    .replace(/^\*:\/\//, 'https://')
    .replace(/\/\*$/, '/')
    .replace('*.', 'www.')
    .replace(/\*/g, '');
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
