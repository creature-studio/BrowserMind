/**
 * Generic JSON-RPC-ish layer used for *every* hop of the system:
 *
 *   runtime  ──websocket──▶  extension background
 *   background ──port──────▶  content script        (chrome.runtime.Port)
 *   background ──postMessage▶ sandboxed plugin host  (third party plugins)
 *   tests    ──direct pair▶  anything
 *
 * One implementation keeps error propagation, timeouts and cancellation
 * identical everywhere, which is why a plugin can be moved between execution
 * contexts without changing a line of its code.
 */
import { toErrorPayload, reviveError } from './errors.js';

export interface Envelope {
  /** `req` = request, `res` = response, `evt` = one-way event. */
  t: 'req' | 'res' | 'evt';
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** Anything that can carry envelopes: WebSocket, chrome Port, postMessage, in-process. */
export interface MessageChannelLike {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  onClose?(handler: () => void): () => void;
}

export type RpcHandler = (params: any, context: RpcCallContext) => unknown | Promise<unknown>;

export interface RpcCallContext {
  peer: RpcPeer;
  method: string;
  /** True when the caller used `notify()` — no reply is sent. */
  isNotification: boolean;
}

export interface RpcPeerOptions {
  name?: string;
  handlers?: Record<string, RpcHandler>;
  /** Default per-request timeout. `0` disables it. */
  timeoutMs?: number;
  onError?: (error: Error, meta: { method?: string; direction: 'in' | 'out' }) => void;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

let rpcSequence = 0;

export class RpcPeer {
  readonly name: string;
  #channel: MessageChannelLike;
  #handlers = new Map<string, RpcHandler>();
  #pending = new Map<string, PendingCall>();
  #detach: (() => void) | null = null;
  #detachClose: (() => void) | null = null;
  #timeoutMs: number;
  #closed = false;
  #onError: RpcPeerOptions['onError'];
  #eventListeners = new Set<(event: { method: string; params: unknown }) => void>();

  constructor(channel: MessageChannelLike, options: RpcPeerOptions = {}) {
    this.#channel = channel;
    this.name = options.name ?? 'peer';
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#onError = options.onError;
    for (const [method, handler] of Object.entries(options.handlers ?? {})) {
      this.#handlers.set(method, handler);
    }
    this.#detach = channel.onMessage((message) => this.#handleMessage(message));
    if (channel.onClose) {
      this.#detachClose = channel.onClose(() => this.#handleTransportClose());
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  handle(method: string, handler: RpcHandler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  onEvent(listener: (event: { method: string; params: unknown }) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Fire an event — used to stream progress/state without a request/response. */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#channel.send({ t: 'evt', method, params } satisfies Envelope);
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) throw new Error(`RPC peer "${this.name}" is closed`);
    const id = `r${++rpcSequence}`;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = { resolve, reject, method };
      if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`RPC "${method}" on "${this.name}" timed out after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
      }
      this.#pending.set(id, pending);
      try {
        this.#channel.send({ t: 'req', id, method, params } satisfies Envelope);
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error as Error);
      }
    });
  }

  async #handleMessage(message: unknown): Promise<void> {
    const envelope = message as Envelope | null;
    if (!envelope || typeof envelope !== 'object' || !envelope.t) return;

    if (envelope.t === 'res') {
      const pending = envelope.id ? this.#pending.get(envelope.id) : undefined;
      if (!pending) return;
      this.#pending.delete(envelope.id!);
      if (pending.timer) clearTimeout(pending.timer);
      if (envelope.error) pending.reject(reviveError(envelope.error));
      else pending.resolve(envelope.result);
      return;
    }

    if (envelope.t === 'evt') {
      for (const listener of this.#eventListeners) {
        try {
          listener({ method: envelope.method ?? '', params: envelope.params });
        } catch (error) {
          this.#onError?.(error as Error, { method: envelope.method, direction: 'in' });
        }
      }
      const handler = this.#handlers.get(`event:${envelope.method}`);
      if (handler) {
        try {
          await handler(envelope.params, { peer: this, method: envelope.method ?? '', isNotification: true });
        } catch (error) {
          this.#onError?.(error as Error, { method: envelope.method, direction: 'in' });
        }
      }
      return;
    }

    if (envelope.t === 'req') {
      const handler = envelope.method ? this.#handlers.get(envelope.method) : undefined;
      if (!handler) {
        this.#channel.send({
          t: 'res',
          id: envelope.id,
          error: { code: 'method_not_found', message: `No handler for "${envelope.method}" on ${this.name}` },
        } satisfies Envelope);
        return;
      }
      try {
        const result = await handler(envelope.params, {
          peer: this,
          method: envelope.method!,
          isNotification: false,
        });
        this.#channel.send({ t: 'res', id: envelope.id, result } satisfies Envelope);
      } catch (error) {
        this.#onError?.(error as Error, { method: envelope.method, direction: 'in' });
        this.#channel.send({ t: 'res', id: envelope.id, error: toErrorPayload(error) } satisfies Envelope);
      }
    }
  }

  #handleTransportClose(): void {
    const error = new Error(`RPC transport for "${this.name}" closed`);
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach?.();
    this.#detachClose?.();
    this.#handleTransportClose();
  }
}

/** In-process channel pair — used by tests and by the simulator. */
export function createLocalChannelPair(options: { async?: boolean } = {}): [MessageChannelLike, MessageChannelLike] {
  const listenersA = new Set<(message: unknown) => void>();
  const listenersB = new Set<(message: unknown) => void>();
  const deliver = (listeners: Set<(message: unknown) => void>, message: unknown) => {
    const run = () => {
      for (const listener of [...listeners]) listener(message);
    };
    if (options.async === false) run();
    else queueMicrotask(run);
  };
  const a: MessageChannelLike = {
    send: (message) => deliver(listenersB, message),
    onMessage: (handler) => {
      listenersA.add(handler);
      return () => listenersA.delete(handler);
    },
  };
  const b: MessageChannelLike = {
    send: (message) => deliver(listenersA, message),
    onMessage: (handler) => {
      listenersB.add(handler);
      return () => listenersB.delete(handler);
    },
  };
  return [a, b];
}

/** Wrap a `postMessage`-style window pair (used for the sandboxed plugin host). */
export function createPostMessageChannel(
  target: { postMessage: (message: unknown, targetOrigin: string) => void },
  origin: string,
  options: { channelId: string; scope: 'host' | 'sandbox' },
): { channel: MessageChannelLike; dispose: () => void } {
  const listeners = new Set<(message: unknown) => void>();
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { __browsermind?: true; channelId?: string; payload?: unknown } | null;
    if (!data || data.__browsermind !== true || data.channelId !== options.channelId) return;
    for (const listener of [...listeners]) listener(data.payload);
  };
  const globalTarget = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
    removeEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
  };
  globalTarget.addEventListener?.('message', onMessage);
  const channel: MessageChannelLike = {
    send: (payload) => target.postMessage({ __browsermind: true, channelId: options.channelId, scope: options.scope, payload }, origin),
    onMessage: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  return {
    channel,
    dispose: () => globalTarget.removeEventListener?.('message', onMessage as never),
  };
}
