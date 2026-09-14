/**
 * Local DOM driver — the fast path.
 *
 * Runs inside the page (content script) or inside a simulator/host DOM and
 * performs real DOM work. Every method is `async` even though the work is
 * synchronous, so that the exact same plugin code also runs against the
 * *remote* driver (see `remote-client.ts`) without changes.
 */
import type {
  DomDriverLike,
  ElementHandle,
  FileUpload,
  ObserveOptions,
  QueryOptions,
  Target,
  TypeOptions,
  WaitForOptions,
} from '../types.js';
import { AbortedError, NotFoundError, TimeoutError } from '../errors.js';

interface ElementRegistry {
  refFor(element: Element): string;
  elementFor(ref: string): Element | null;
}

export interface DomDriverEnvironment {
  document: Document;
  window: Window;
  /** Milliseconds; injectable so tests can time travel. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  ' ': 32,
};

function isJsdom(win: Window): boolean {
  try {
    return /jsdom/i.test(win.navigator?.userAgent ?? '');
  } catch {
    return false;
  }
}

function createRegistry(): ElementRegistry {
  const byRef = new Map<string, WeakRef<Element>>();
  let counter = 0;
  return {
    refFor(element) {
      for (const [ref, weak] of byRef) {
        if (weak.deref() === element) return ref;
      }
      const ref = `e${++counter}`;
      byRef.set(ref, new WeakRef(element));
      if (byRef.size > 4000) {
        for (const [key, weak] of byRef) {
          if (!weak.deref()) byRef.delete(key);
        }
      }
      return ref;
    },
    elementFor(ref) {
      const element = byRef.get(ref)?.deref();
      if (!element) return null;
      if (!(element as Element).isConnected) return null;
      return element;
    },
  };
}

export function createLocalDomDriver(env: DomDriverEnvironment): DomDriverLike {
  const { document: doc, window: win } = env;
  const now = env.now ?? (() => Date.now());
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const registry = createRegistry();
  const jsdomLike = isJsdom(win);

  const handle = (element: Element | null | undefined): ElementHandle | null => {
    if (!element) return null;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      ref: registry.refFor(element),
      tag: element.tagName.toLowerCase(),
      text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
    };
  };

  const resolve = (target: Target | null | undefined): Element | null => {
    if (!target) return null;
    if (typeof target === 'string') return doc.querySelector(target);
    return registry.elementFor(target.ref);
  };

  const requireElement = (target: Target | null | undefined, what = 'element'): Element => {
    const element = resolve(target);
    if (!element) throw new NotFoundError(`Could not resolve ${what}`);
    return element;
  };

  const isVisible = (element: Element | null): boolean => {
    if (!element || !element.isConnected) return false;
    if (element.hasAttribute?.('hidden')) return false;
    let style: CSSStyleDeclaration | undefined;
    try {
      style = win.getComputedStyle(element as Element);
    } catch {
      style = undefined;
    }
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (style.opacity && Number(style.opacity) === 0) return false;
    }
    // jsdom has no layout engine: offsetParent/rect checks would reject everything.
    if (jsdomLike) return true;
    const rect = (element as HTMLElement).getBoundingClientRect?.();
    if (rect && rect.width === 0 && rect.height === 0) {
      if (style?.position === 'fixed' || style?.position === 'absolute') return true;
      return false;
    }
    return true;
  };

  const delay = (ms: number) => (ms > 0 ? sleep(ms) : Promise.resolve());

  const dispatchInputEvents = (element: Element) => {
    const EventCtor = (win as any).InputEvent ?? (win as any).Event;
    element.dispatchEvent(new (win as any).Event('input', { bubbles: true, cancelable: true }));
    try {
      element.dispatchEvent(new EventCtor('input', { bubbles: true, cancelable: true, data: null, inputType: 'insertText' }));
    } catch {
      /* older jsdom: ignore */
    }
    element.dispatchEvent(new (win as any).Event('change', { bubbles: true }));
  };

  const setNativeValue = (element: Element, text: string) => {
    const proto =
      element instanceof (win as any).HTMLTextAreaElement
        ? (win as any).HTMLTextAreaElement.prototype
        : element instanceof (win as any).HTMLInputElement
          ? (win as any).HTMLInputElement.prototype
          : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined;
    if (descriptor?.set) descriptor.set.call(element, text);
    else (element as any).value = text;
  };

  const typeIntoElement = async (element: Element, text: string, options: TypeOptions) => {
    const mode = options.mode ?? 'auto';
    const tag = element.tagName.toLowerCase();
    const isEditableHost = (element as HTMLElement).isContentEditable === true || element.getAttribute?.('contenteditable') === 'true';

    if (options.clear !== false) {
      if (mode === 'value' || (mode === 'auto' && (tag === 'input' || tag === 'textarea'))) {
        setNativeValue(element, '');
      } else if (isEditableHost) {
        (element as HTMLElement).textContent = '';
      }
    }

    element.dispatchEvent(new (win as any).Event('focus', { bubbles: true }));
    if (mode === 'value' || (mode === 'auto' && (tag === 'input' || tag === 'textarea'))) {
      setNativeValue(element, text);
      if (options.delayMs) await delay(options.delayMs);
      dispatchInputEvents(element);
    } else if (mode === 'keys') {
      for (const char of text) {
        const key = char === ' ' ? ' ' : char;
        element.dispatchEvent(
          new (win as any).KeyboardEvent('keydown', { key, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true }),
        );
        if (isEditableHost) (element as HTMLElement).textContent = ((element as HTMLElement).textContent ?? '') + char;
        else setNativeValue(element, ((element as HTMLInputElement).value ?? '') + char);
        element.dispatchEvent(new (win as any).KeyboardEvent('keyup', { key, bubbles: true }));
        dispatchInputEvents(element);
        if (options.delayMs) await delay(options.delayMs);
      }
    } else {
      // contenteditable / rich editor
      const execCommand = (doc as unknown as { execCommand?: (cmd: string, ui: boolean, value?: string) => boolean }).execCommand;
      let inserted = false;
      if (typeof execCommand === 'function') {
        try {
          inserted = execCommand.call(doc, 'insertText', false, text);
        } catch {
          inserted = false;
        }
      }
      if (!inserted) {
        const paragraphs = text.split('\n');
        (element as HTMLElement).textContent = paragraphs.join('\n');
      }
      dispatchInputEvents(element);
    }

    if (options.submit) {
      await pressKey(element, 'Enter');
    }
  };

  const buildKeyboardEvent = (type: string, init: Record<string, unknown>) => new (win as any).KeyboardEvent(type, init);

  const pressKey = async (element: Element | null, key: string) => {
    const targetElement = element ?? (doc.activeElement as Element | null) ?? doc.body ?? doc.documentElement;
    const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const init = {
      key,
      code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    if (targetElement) {
      (targetElement as HTMLElement).focus?.();
      targetElement.dispatchEvent(buildKeyboardEvent('keydown', init));
      targetElement.dispatchEvent(buildKeyboardEvent('keypress', init));
      targetElement.dispatchEvent(buildKeyboardEvent('keyup', init));
    }
    // Escalation for editors that listen on the document/window.
    const alt = { ...init, bubbles: true, cancelable: true };
    doc.dispatchEvent(buildKeyboardEvent('keydown', alt));
    doc.dispatchEvent(buildKeyboardEvent('keyup', alt));
  };

  const readValue = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return (element as HTMLInputElement).value ?? '';
    if (tag === 'select') return (element as HTMLSelectElement).value ?? '';
    return (element as HTMLElement).textContent ?? '';
  };

  const clickElement = (element: Element) => {
    const rect = (element as HTMLElement).getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.x ?? 0,
      clientY: rect.y ?? 0,
      button: 0,
    };
    const PointerEventCtor = (win as any).PointerEvent;
    if (typeof PointerEventCtor === 'function') {
      element.dispatchEvent(new PointerEventCtor('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
    }
    element.dispatchEvent(new (win as any).MouseEvent('mousedown', base));
    (element as HTMLElement).focus?.();
    if (typeof PointerEventCtor === 'function') {
      element.dispatchEvent(new PointerEventCtor('pointerup', { ...base, pointerId: 1, isPrimary: true }));
    }
    element.dispatchEvent(new (win as any).MouseEvent('mouseup', base));
    element.dispatchEvent(new (win as any).MouseEvent('click', base));
    if (typeof (element as HTMLElement).click === 'function') {
      // Guarantees non-mouse driven handlers (and jsdom listeners) always fire.
      (element as HTMLElement).click();
    }
  };

  const decodeBase64 = (value: string): Uint8Array => {
    const globalAtob = (win as any).atob as ((input: string) => string) | undefined;
    if (typeof globalAtob === 'function') {
      const binary = globalAtob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(value, 'base64'));
  };

  const buildFiles = (files: FileUpload[]): File[] => {
    const FileCtor = (win as any).File;
    return files.map((file) => {
      const bytes = file.base64 ? decodeBase64(file.base64) : new TextEncoder().encode(file.text ?? '');
      const name = file.name || 'upload.txt';
      if (typeof FileCtor === 'function') {
        return new FileCtor([bytes], name, { type: file.mimeType ?? 'text/plain' });
      }
      return { name, bytes } as unknown as File;
    });
  };

  /**
   * One broken candidate in a selector list must never take the whole plugin
   * down (real sites change markup constantly), so an invalid compound
   * selector falls back to trying each part on its own.
   */
  const safeQuery = (scope: ParentNode, selector: string): Element[] => {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch {
      const parts = selector.split(',');
      if (parts.length < 2) return [];
      const out: Element[] = [];
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          out.push(...Array.from(scope.querySelectorAll(trimmed)));
        } catch {
          /* skip unusable candidate */
        }
      }
      return out;
    }
  };

  const queryOnce = (options: QueryOptions): Element[] => {
    const scope: ParentNode = options.root ? ((resolve(options.root) as ParentNode) ?? doc) : doc;
    let found = safeQuery(scope, options.selector);
    if (options.visible) found = found.filter((element) => isVisible(element));
    return found;
  };

  const query = async (options: QueryOptions): Promise<ElementHandle | null> => {
    const found = queryOnce(options);
    // Negative indexes select from the end (`-1` = newest element) which is how
    // plugins read the *latest* AI answer without knowing how many there are.
    const element = options.index != null ? found.at(options.index) : found[0];
    return handle(element ?? null);
  };

  const waitForSelector = async (selector: string, options: WaitForOptions = {}): Promise<Element | null> => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const pollMs = options.pollMs ?? 100;
    const state = options.state ?? 'attached';
    const started = now();
    for (;;) {
      if (options.signal?.aborted) throw new AbortedError();
      const element = doc.querySelector(selector);
      const visible = isVisible(element);
      const satisfied =
        state === 'attached'
          ? Boolean(element)
          : state === 'detached'
            ? !element
            : state === 'visible'
              ? Boolean(element) && visible
              : !element || !visible;
      if (satisfied) return element;
      if (now() - started >= timeoutMs) {
        if (state === 'detached' || state === 'hidden') return null;
        throw new TimeoutError(`Timed out waiting for "${selector}" to be ${state}`, { selector, timeoutMs });
      }
      await delay(pollMs);
    }
  };

  return {
    location: 'local',

    async query(options) {
      const element = await query(options);
      return element;
    },

    async queryAll(options) {
      return queryOnce(options).map((element) => handle(element)!).filter(Boolean);
    },

    async count(options) {
      return queryOnce(options).length;
    },

    async exists(options) {
      return queryOnce(options).length > 0;
    },

    async text(target, options) {
      const element = await resolveWithWait(target, options?.timeoutMs);
      if (!element) return '';
      const raw = (element as HTMLElement).innerText ?? element.textContent ?? '';
      return options?.trim === false ? raw : raw.replace(/\s+/g, ' ').trim();
    },

    async attr(target, name) {
      const element = resolve(target);
      return element ? element.getAttribute(name) : null;
    },

    async value(target) {
      const element = resolve(target);
      return element ? readValue(element) : '';
    },

    async isVisible(target) {
      return isVisible(resolve(target));
    },

    async click(target, options) {
      if (options?.timeoutMs) await resolveWithWait(target, options.timeoutMs);
      const element = requireElement(target, 'click target');
      clickElement(element);
    },

    async type(target, text, options = {}) {
      const element = requireElement(target, 'input element');
      await typeIntoElement(element, text, options);
    },

    async press(target, key) {
      await pressKey(resolve(target), key);
    },

    async check(target, checked) {
      const element = requireElement(target, 'checkbox');
      const isChecked = (element as HTMLInputElement).checked;
      if (isChecked !== checked) clickElement(element);
    },

    async scrollIntoView(target) {
      const element = resolve(target);
      (element as HTMLElement)?.scrollIntoView?.({ block: 'nearest' });
    },

    async upload(target, files) {
      const element = requireElement(target, 'file input') as HTMLInputElement;
      const built = buildFiles(files);
      const DataTransferCtor = (win as any).DataTransfer;
      if (typeof DataTransferCtor === 'function') {
        const transfer = new DataTransferCtor();
        for (const file of built) transfer.items.add(file);
        try {
          element.files = transfer.files;
        } catch {
          Object.defineProperty(element, 'files', { value: transfer.files, configurable: true, writable: true });
        }
      } else {
        Object.defineProperty(element, 'files', { value: built, configurable: true, writable: true });
      }
      element.dispatchEvent(new (win as any).Event('input', { bubbles: true }));
      element.dispatchEvent(new (win as any).Event('change', { bubbles: true }));
      return built.length;
    },

    async waitFor(selector, options) {
      const element = await waitForSelector(selector, options);
      return handle(element);
    },

    async observeText(target, options: ObserveOptions = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const quietMs = options.quietMs ?? 900;
      const pollMs = options.pollMs ?? 120;
      const minLength = options.minLength ?? 1;
      const started = now();
      let lastText = '';
      let lastChangeAt = now();
      let firstSeenAt: number | null = null;

      for (;;) {
        if (options.signal?.aborted) throw new AbortedError();
        const element = resolve(target);
        const current = element
          ? ((element as HTMLElement).innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim()
          : '';
        if (current !== lastText) {
          lastText = current;
          lastChangeAt = now();
          if (firstSeenAt === null && current.length >= minLength) firstSeenAt = now();
          options.onProgress?.(current);
        }
        const quietFor = now() - lastChangeAt;
        const elapsed = now() - started;
        const hasEnough = lastText.length >= minLength;
        if (hasEnough && quietFor >= quietMs && firstSeenAt !== null) return lastText;
        if (elapsed >= timeoutMs) return lastText;
        await delay(pollMs);
      }
    },

    async info() {
      return { url: win.location?.href ?? '', title: doc.title ?? '' };
    },
  };

  async function resolveWithWait(target: Target, timeoutMs?: number): Promise<Element | null> {
    if (typeof target !== 'string' || !timeoutMs) return resolve(target);
    return waitForSelector(target, { timeoutMs, state: 'visible' });
  }
}

/** Convenience factory used by content scripts and simulators. */
export function createDomDriverFromWindow(win: Window): DomDriverLike {
  return createLocalDomDriver({ document: win.document, window: win });
}
