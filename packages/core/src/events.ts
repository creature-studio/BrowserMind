/** Minimal typed event emitter (works in browser + node, no dependency). */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        console.error('[browsermind] listener error', error);
      }
    }
  }

  removeAll(): void {
    this.#listeners.clear();
  }
}

/** Await a single event, with timeout + abort support. */
export function waitForEvent<Events extends object, K extends keyof Events>(
  emitter: Emitter<Events>,
  event: K,
  options: { timeoutMs?: number; signal?: AbortSignal; predicate?: (payload: Events[K]) => boolean } = {},
): Promise<Events[K]> {
  const { timeoutMs = 30_000, signal, predicate } = options;
  return new Promise<Events[K]>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      off();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const off = emitter.on(event, (payload) => {
      if (predicate && !predicate(payload)) return;
      cleanup();
      resolve(payload);
    });
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for event "${String(event)}"`));
      }, timeoutMs);
    }
  });
}
