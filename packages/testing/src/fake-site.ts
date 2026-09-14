/**
 * Fake site runtime.
 *
 * Installs the behaviour of a chat provider inside a jsdom page:
 * submits the composer on Enter/click, streams the answer chunk by chunk,
 * toggles the streaming indicators, supports stop/new-chat/file upload and
 * can simulate a login wall or a stalled stream.
 */
import { JSDOM } from 'jsdom';
import { createLocalDomDriver, type DomDriverLike } from '../../core/src/index.js';
import { chunkText, defaultReplyText, escapeHtml, SITE_TEMPLATES, type FakeSiteTemplate } from './sites.js';

export interface FakeSiteOptions {
  provider: string;
  url?: string;
  /** Chunks emitted for a given user message. */
  reply?: (message: string, turn: number) => string[];
  chunkDelayMs?: number;
  firstChunkDelayMs?: number;
  /** Show the login wall and hide the composer. */
  loginRequired?: boolean;
  /** Emit only N chunks and never finish (timeout/partial-answer testing). */
  stallAfterChunks?: number;
}

export interface FakeSite {
  provider: string;
  url: string;
  window: Window;
  document: Document;
  driver: DomDriverLike;
  template: FakeSiteTemplate;
  /** Messages the site received, in order. */
  submissions: string[];
  /** File names attached through the file input. */
  uploads: string[];
  completedCount: number;
  isGenerating(): boolean;
  setLoginRequired(value: boolean): void;
  setReply(reply: (message: string, turn: number) => string[]): void;
  stallAfterChunks(count: number | null): void;
  waitForCompletion(timeoutMs?: number): Promise<string>;
  /** Simulate a page the plugin cannot drive (composer removed). */
  removeComposer(): void;
  destroy(): void;
}

export function createFakeSite(options: FakeSiteOptions): FakeSite {
  const template = SITE_TEMPLATES[options.provider];
  if (!template) throw new Error(`Unknown fake site "${options.provider}"`);
  const url = options.url ?? template.url;
  const dom = new JSDOM(template.html, { url, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;

  const state = {
    submissions: [] as string[],
    uploads: [] as string[],
    generating: false,
    stallAfterChunks: options.stallAfterChunks ?? null,
    completedCount: 0,
    loginRequired: options.loginRequired ?? false,
    chunkDelayMs: options.chunkDelayMs ?? 12,
    firstChunkDelayMs: options.firstChunkDelayMs ?? 8,
    reply:
      options.reply ??
      ((message: string, turn: number) => chunkText(defaultReplyText(template.provider, message), 10)),
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastResponseText = '';
  const completionWaiters = new Set<(text: string) => void>();

  const query = <T extends Element = Element>(selector: string): T | null => doc.querySelector<T>(selector);
  const composer = (): HTMLElement | null => query<HTMLElement>(template.hooks.composer);
  const messages = (): HTMLElement | null => query<HTMLElement>(template.hooks.messages);

  const readComposer = (): string => {
    const element = composer();
    if (!element) return '';
    if (template.composerKind === 'textarea') return (element as HTMLTextAreaElement).value ?? '';
    return element.textContent ?? '';
  };

  const clearComposer = (): void => {
    const element = composer();
    if (!element) return;
    if (template.composerKind === 'textarea') (element as HTMLTextAreaElement).value = '';
    else element.textContent = '';
  };

  const setHidden = (selector: string | undefined, hidden: boolean): void => {
    if (!selector) return;
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      if (hidden) element.setAttribute('hidden', '');
      else element.removeAttribute('hidden');
    }
  };

  const render = (markup: string, id: string, text: string): string =>
    markup.replace(/\{\{\{id\}\}\}/g, escapeHtml(id)).replace(/\{\{\{text\}\}\}/g, escapeHtml(text));

  const append = (markup: string): Element | null => {
    const container = messages();
    if (!container) return null;
    const wrapper = doc.createElement('div');
    wrapper.innerHTML = markup;
    const element = wrapper.firstElementChild!;
    container.appendChild(element);
    return element;
  };

  const setGenerating = (value: boolean): void => {
    state.generating = value;
    setHidden(template.hooks.stop, !value);
    setHidden(template.hooks.streaming, !value);
    const send = query<HTMLElement>(template.hooks.send);
    if (send) {
      send.setAttribute('aria-disabled', value ? 'true' : 'false');
      if ('disabled' in send) (send as HTMLButtonElement).disabled = value;
    }
  };

  const applyStreamingClass = (element: Element | null, on: boolean): void => {
    if (!template.hooks.streamingClass) return;
    const target = element?.querySelector('[class*="markdown"]') ?? element;
    if (!target) return;
    if (on) target.classList.add(template.hooks.streamingClass);
    else target.classList.remove(template.hooks.streamingClass);
  };

  const finishStream = (element: Element | null): void => {
    setGenerating(false);
    applyStreamingClass(element, false);
    state.completedCount += 1;
    for (const waiter of [...completionWaiters]) waiter(lastResponseText);
    completionWaiters.clear();
    window.dispatchEvent(new window.CustomEvent('browsermind:fake-response', { detail: { text: lastResponseText } }));
  };

  const submit = (): void => {
    if (state.generating) return;
    const text = readComposer();
    if (!text.trim()) return;
    state.submissions.push(text);
    clearComposer();
    append(render(template.userBubble, `u${state.submissions.length}`, text));
    const bubble = append(render(template.assistantBubble, `a${state.submissions.length}`, ''));
    const textEl = bubble?.querySelector('[class*="markdown"]') ?? bubble;

    const chunks = state.reply(text, state.submissions.length);
    let index = 0;
    lastResponseText = '';
    setGenerating(true);
    applyStreamingClass(bubble, true);

    const tick = () => {
      timer = null;
      if (!state.generating) return; // stopped by the user
      if (state.stallAfterChunks != null && index >= state.stallAfterChunks) return;
      if (index >= chunks.length) {
        finishStream(bubble);
        return;
      }
      lastResponseText += chunks[index++]!;
      if (textEl) textEl.textContent = lastResponseText;
      timer = setTimeout(tick, state.chunkDelayMs);
    };
    timer = setTimeout(tick, state.firstChunkDelayMs);
  };

  /* ----------------------------- site wiring ----------------------------- */

  const onKeyDown = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key !== 'Enter' || keyboard.shiftKey) return;
    const target = event.target as Element | null;
    if (!target || !composer()) return;
    if (target !== composer() && !composer()!.contains(target)) return;
    if (keyboard.ctrlKey || keyboard.metaKey) return; // Ctrl+Enter inserts a newline on most sites
    event.preventDefault();
    submit();
  };

  const onClickSend = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest(template.hooks.send)) submit();
  };

  const onClickStop = (event: Event) => {
    if (!template.hooks.stop) return;
    const target = event.target as Element | null;
    if (!target?.closest(template.hooks.stop)) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    state.generating = false;
    setGenerating(false);
    applyStreamingClass(messages()?.lastElementChild ?? null, false);
  };

  const onClickNewChat = (event: Event) => {
    if (!template.hooks.newChat) return;
    const target = event.target as Element | null;
    if (!target?.closest(template.hooks.newChat)) return;
    const container = messages();
    if (container) container.innerHTML = '';
    setGenerating(false);
    const wall = template.hooks.loginWall ? query(template.hooks.loginWall) : null;
    wall?.setAttribute('hidden', '');
    state.submissions.length = 0;
  };

  const onFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input || !template.hooks.fileInput) return;
    if (!input.matches(template.hooks.fileInput)) return;
    const files = Array.from(input.files ?? []);
    for (const file of files) state.uploads.push(file.name);
  };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('click', onClickSend, true);
  doc.addEventListener('click', onClickStop, true);
  doc.addEventListener('click', onClickNewChat, true);
  if (template.hooks.fileInput) doc.addEventListener('change', onFileChange, true);

  const setLoginRequired = (value: boolean) => {
    state.loginRequired = value;
    setHidden(template.hooks.loginWall, !value);
    const element = composer();
    if (element) {
      if (value) element.setAttribute('hidden', '');
      else element.removeAttribute('hidden');
    }
  };
  if (state.loginRequired) setLoginRequired(true);

  const driver = createLocalDomDriver({ document: doc, window: window as unknown as Window });

  return {
    provider: template.provider,
    url,
    window: window as unknown as Window,
    document: doc,
    driver,
    template,
    get submissions() {
      return state.submissions;
    },
    get uploads() {
      return state.uploads;
    },
    get completedCount() {
      return state.completedCount;
    },
    isGenerating: () => state.generating,
    setLoginRequired,
    setReply: (reply) => {
      state.reply = reply;
    },
    stallAfterChunks: (count) => {
      state.stallAfterChunks = count;
    },
    waitForCompletion: (timeoutMs = 15_000) =>
      new Promise<string>((resolve, reject) => {
        if (!state.generating && state.completedCount > 0) return resolve(lastResponseText);
        const timerId = setTimeout(() => reject(new Error('fake site never completed its response')), timeoutMs);
        completionWaiters.add((text) => {
          clearTimeout(timerId);
          resolve(text);
        });
      }),
    removeComposer: () => {
      composer()?.remove();
    },
    destroy: () => {
      if (timer) clearTimeout(timer);
      completionWaiters.clear();
      dom.window.close();
    },
  };
}
