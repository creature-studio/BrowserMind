/** Extension settings, persisted in `chrome.storage.local`. */
import { browser } from 'wxt/browser';

export interface ExtensionSettings {
  /** WebSocket endpoint of the runtime, e.g. `ws://127.0.0.1:8765/browsermind/extension`. */
  runtimeUrl: string;
  /** Try to reconnect forever. */
  autoReconnect: boolean;
  /** Focus the composer of a page when the runtime sends a message. */
  autoFocusComposer: boolean;
  /** Log verbose diagnostics to the service worker console. */
  verboseLogging: boolean;
  /** Manifests installed on the runtime side, mirrored for dynamic content scripts. */
  installedManifests: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  runtimeUrl: 'ws://127.0.0.1:8765/browsermind/extension',
  autoReconnect: true,
  autoFocusComposer: true,
  verboseLogging: false,
  installedManifests: {},
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<ExtensionSettings>) ?? {}) };
}

export async function setSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = { ...current, ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
