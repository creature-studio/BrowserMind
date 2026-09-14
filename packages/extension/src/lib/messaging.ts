/** Typed messages between the popup/options pages and the background worker. */
import { browser } from 'wxt/browser';
import type { PluginManifest, WorkerDescriptor } from '@browsermind/core/browser';

export interface ExtensionState {
  runtimeUrl: string;
  runtimeConnected: boolean;
  lastError?: string;
  workers: WorkerDescriptor[];
  sessions: Array<{
    id: string;
    pluginId: string;
    url: string;
    title?: string;
    tabId?: number;
    location: string;
    attached: boolean;
  }>;
  plugins: Array<{ id: string; name: string; version: string; matchPatterns: string[]; source?: string; granted: boolean }>;
}

export type ExtensionMessage =
  | { type: 'state.get' }
  | { type: 'runtime.reconnect' }
  | { type: 'runtime.request'; method: string; params?: unknown }
  | { type: 'settings.set'; patch: Record<string, unknown> }
  | { type: 'tabs.open'; provider?: string; url?: string; active?: boolean }
  | { type: 'tabs.close'; tabId: number }
  | { type: 'tabs.focus'; tabId: number }
  | { type: 'tabs.highlight'; tabId: number }
  | { type: 'plugins.grant'; origins: string[] }
  | { type: 'plugins.install'; manifest: PluginManifest }
  | { type: 'plugins.remove'; id: string }
  | { type: 'logs.get' };

export interface MessageResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendMessage<T = unknown>(message: ExtensionMessage): Promise<MessageResponse<T>> {
  return (await browser.runtime.sendMessage(message)) as MessageResponse<T>;
}
