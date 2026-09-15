/**
 * The whole DOM layer of the console: a 20-line `h()` and a tiny reactive store.
 * Deliberately framework-free — the page is inlined into one HTML file and also
 * mounted inside a Chrome extension, so a runtime dependency would be a liability.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'value') (node as HTMLInputElement).value = String(value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') (node as unknown as Record<string, unknown>)[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/** Replace the children of a node in one go (and accept `cond ? node : null`). */
export function mount(node: Element, ...children: Child[]): void {
  node.replaceChildren();
  append(node, children);
}

/** `el('workers')` — every panel of the page is mounted into a stable id. */
export function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`console: missing #${id}`);
  return node;
}

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T>): void;
  update(mutate: (state: T) => Partial<T> | void): void;
  subscribe(listener: (state: T) => void): () => void;
}

/** Minimal observable state; `set` is batched into one microtask per tick. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  let queued = false;
  const flush = () => {
    queued = false;
    for (const listener of listeners) listener(state);
  };
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
    },
    update(mutate) {
      const patch = mutate(state);
      this.set(patch ?? {});
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
}

/* --------------------------------- helpers -------------------------------- */

export const time = (at: number): string => new Date(at).toLocaleTimeString();

export function statusLabel(status: string): string {
  return (
    {
      idle: '空闲',
      ready: '就绪',
      busy: '生成中',
      waiting: '等待页面',
      blocked: '需要你处理',
      error: '上次失败',
      offline: '页面已关闭',
    }[status] ?? status
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error) {
    const payload = error as { message?: string; error?: string };
    if (payload.message) return payload.error ? `[${payload.error}] ${payload.message}` : payload.message;
  }
  return String(error);
}

export async function jsonError(response: Response): Promise<never> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    if (payload.message) detail = `[${payload.error ?? response.status}] ${payload.message}`;
  } catch {
    /* non-JSON error body */
  }
  throw new Error(detail);
}
