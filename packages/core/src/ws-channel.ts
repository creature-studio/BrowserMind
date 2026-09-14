/**
 * WebSocket → `MessageChannelLike`.
 *
 * A client-side `WebSocket` is not ready to carry RPC the instant it is
 * created: the socket only opens a moment later, and — crucially — the peer on
 * the other end starts talking *immediately* after the handshake (the runtime's
 * very first act is `session.list`). Frames that arrive before someone
 * subscribed would otherwise be dropped, which silently breaks the attach.
 *
 * This adapter therefore buffers in both directions: incoming frames until a
 * message handler is attached, outgoing envelopes until the socket is open.
 */
import type { MessageChannelLike } from './rpc.js';

/** Structural subset shared by DOM `WebSocket` and the `ws` package. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): unknown;
  removeEventListener?(type: string, listener: (event: unknown) => void): unknown;
  on?(type: string, listener: (...args: unknown[]) => void): unknown;
  off?(type: string, listener: (...args: unknown[]) => void): unknown;
}

const OPEN = 1;

/** Subscribe with whichever API the socket exposes (DOM / event-target-shim / node-ws). */
function listen(socket: WebSocketLike, type: string, handler: (event: unknown) => void): () => void {
  if (typeof socket.addEventListener === 'function') {
    const listener = (event: unknown) => handler(event);
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (typeof socket.on === 'function') {
    const listener = (...args: unknown[]) => handler(args.length > 1 ? args : args[0]);
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }
  return () => undefined;
}

/** `MessageEvent.data` for DOM/ws event-target sockets, the raw payload for node-ws `.on`. */
function payloadOf(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event) return (event as { data: unknown }).data;
  return event;
}

function textOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && typeof (payload as { toString(): string }).toString === 'function') {
    return String(payload);
  }
  return '';
}

export function createWebSocketChannel(socket: WebSocketLike): MessageChannelLike {
  const pendingIncoming: unknown[] = [];
  const pendingOutgoing: unknown[] = [];
  const closeHandlers = new Set<() => void>();
  let handler: ((message: unknown) => void) | null = null;
  let open = socket.readyState === OPEN;

  let flushScheduled = false;
  const deliver = (message: unknown): void => {
    if (pendingIncoming.length) pendingIncoming.push(message);
    else if (handler) handler(message);
    else pendingIncoming.push(message);
  };
  /**
   * Buffered frames are released on a later turn: the peer that is about to be
   * built on this channel registers its handlers right after the constructor,
   * and must see them before the first frame is processed.
   */
  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    const run = (): void => {
      flushScheduled = false;
      while (handler && pendingIncoming.length) handler(pendingIncoming.shift());
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setTimeout(run, 0);
  };
  const fireClose = (): void => {
    for (const listener of [...closeHandlers]) listener();
  };

  listen(socket, 'open', () => {
    open = true;
    while (pendingOutgoing.length) socket.send(JSON.stringify(pendingOutgoing.shift()));
  });
  listen(socket, 'message', (event) => {
    try {
      deliver(JSON.parse(textOf(payloadOf(event))));
      if (pendingIncoming.length && handler) scheduleFlush();
    } catch {
      /* malformed frame: ignore, a broken peer should not take the channel down */
    }
  });
  // Always attached so node-ws does not crash on an unhandled 'error' event.
  listen(socket, 'close', fireClose);
  listen(socket, 'error', () => undefined);

  return {
    send: (message) => {
      if (!open) {
        pendingOutgoing.push(message);
        return;
      }
      socket.send(JSON.stringify(message));
    },
    onMessage: (next) => {
      handler = next;
      if (pendingIncoming.length) scheduleFlush();
      return () => {
        if (handler === next) handler = null;
      };
    },
    onClose: (next) => {
      closeHandlers.add(next);
      return () => closeHandlers.delete(next);
    },
  };
}
