/**
 * `chrome.runtime.Port` → `MessageChannelLike`.
 *
 * Adapter so the extension can reuse the core RPC layer (same envelopes,
 * same error propagation, same timeouts) on *every* hop.
 */
import type { MessageChannelLike } from '@browsermind/core/browser';

export interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  disconnect(): void;
}

export function createPortChannel(port: PortLike): MessageChannelLike {
  return {
    send: (message) => {
      try {
        port.postMessage(message);
      } catch {
        /* port closed */
      }
    },
    onMessage: (handler) => {
      const listener = (message: unknown) => handler(message);
      port.onMessage.addListener(listener);
      return () => port.onMessage.removeListener(listener);
    },
    onClose: (handler) => {
      port.onDisconnect.addListener(handler);
      return () => port.onDisconnect.removeListener(handler);
    },
  };
}
