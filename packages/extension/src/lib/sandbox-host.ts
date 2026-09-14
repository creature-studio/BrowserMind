/**
 * Background side of the sandboxed plugin host.
 *
 * Third-party plugins must not run inside the page (they would see the
 * user's whole DOM and cookies). Instead they run in `sandbox.html`, which has
 * no extension privileges, and reach the page only through DOM calls tunnelled
 * by this module:
 *
 *   sandbox plugin ──dom.*──▶ background ──dom.call──▶ content script ──▶ DOM
 *
 * The session is then registered like any other page session, so the runtime
 * sees it as a normal worker with `location: "sandbox"`.
 */
import {
  RpcPeer,
  createSessionDomDriver,
  createLogger,
  serveDomDriver,
  type Logger,
  type PluginManifest,
} from '@browsermind/core/browser';
import { createPortChannel, type PortLike } from './port-channel';
import { getSettings } from './settings';
import type { TabManager } from './tab-manager';

export interface SandboxInitRequest {
  tabId: number;
  pluginId: string;
  /** Optional JS source for a code-based third-party plugin (evaluated only in the sandbox). */
  adapterSource?: string;
}

export interface SandboxInitResult {
  ok: boolean;
  error?: string;
  sessionId: string;
  pluginId: string;
  pluginName: string;
  capabilities: string[];
  url: string;
}

export async function handleSandboxPort(port: PortLike, tabs: TabManager, logger: Logger): Promise<void> {
  const channel = createPortChannel(port);
  const peer = new RpcPeer(channel, { name: 'sandbox', timeoutMs: 0 });
  logger.info('sandbox connected');

  peer.handle('sandbox.init', async (request: SandboxInitRequest): Promise<SandboxInitResult> => {
    const session = tabs.sessionForTab(request.tabId);
    const contentPeer = tabs.contentPeerFor(request.tabId);
    if (!session) throw new Error(`Tab ${request.tabId} has no BrowserMind session (open the provider page first)`);
    if (!contentPeer) throw new Error('The page content script is not connected');

    const settings = await getSettings();
    const manifest = Object.values(settings.installedManifests ?? {}).find(
      (candidate) => (candidate as PluginManifest)?.id === request.pluginId,
    ) as PluginManifest | undefined;
    if (!manifest && !request.adapterSource) {
      throw new Error(`Unknown plugin "${request.pluginId}" and no adapterSource provided`);
    }

    // The sandbox drives the *real page* through this tunnelled driver.
    const pageDriver = createSessionDomDriver(contentPeer, session.id);
    serveDomDriver(peer, pageDriver, { prefix: 'dom.' });

    const sandboxSessionId = `sandbox-${request.tabId}-${request.pluginId}`;
    const pluginName = manifest?.name ?? request.pluginId;
    const capabilities = manifest?.capabilities ?? ['chat'];
    tabs.registerSandboxSession({
      id: sandboxSessionId,
      tabId: request.tabId,
      peer,
      pluginId: request.pluginId,
      pluginName,
      url: session.url,
      capabilities,
    });

    peer.notify('sandbox.ready', { sessionId: sandboxSessionId, manifest });
    logger.info('sandbox session ready', { sessionId: sandboxSessionId, plugin: request.pluginId });
    return {
      ok: true,
      sessionId: sandboxSessionId,
      pluginId: request.pluginId,
      pluginName,
      capabilities,
      url: session.url,
    };
  });

  channel.onClose?.(() => {
    logger.info('sandbox disconnected');
    for (const session of tabs.list()) {
      if (session.location === 'sandbox') tabs.detachTab(session.tabId, 'sandbox-closed');
    }
  });
}

export { createLogger };
