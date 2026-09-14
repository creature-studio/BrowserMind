/**
 * chatgpt.com selector pack.
 *
 * ChatGPT uses a ProseMirror contenteditable composer, so the plugin relies on
 * the driver's `insertText` path (with an execCommand fallback) instead of
 * writing `.value`.
 */
import type { SelectorPack } from '@browsermind/core/browser';

export const chatgptSelectors: SelectorPack = {
  input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[data-id="root"]'],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[data-testid="composer-speech-button"] ~ button',
  ],
  submitKeys: ['Enter'],

  response: [
    'article[data-message-author-role="assistant"] .markdown',
    'div[data-message-author-role="assistant"] .markdown',
    '[data-testid^="conversation-turn-"]:last-child .markdown',
  ],
  streaming: ['.result-streaming', 'button[data-testid="stop-button"]:not([hidden])'],
  busy: ['button[data-testid="send-button"]:disabled', 'button[data-testid="stop-button"]:not([hidden])'],
  ready: ['#prompt-textarea'],
  blocked: ['#login-wall:not([hidden])', '[data-testid="login-modal"]:not([hidden])'],

  fileInput: ['input[data-testid="file-input"]', 'input[type="file"]'],
  attachButton: ['button[aria-label*="ttach"]', 'button[data-testid="composer-attach-button"]'],

  newChat: ['a[data-testid="new-chat-button"]', 'button[data-testid="new-chat-button"]', 'a[href="/"]'],
  stopButton: ['button[data-testid="stop-button"]:not([hidden])'],
  userMessage: ['article[data-message-author-role="user"] .whitespace-pre-wrap', '[data-message-author-role="user"]'],

  actions: [
    {
      id: 'toggle-tools',
      label: 'Tools / browsing',
      kind: 'toggle',
      selector: 'button[aria-label*="Tools"]',
      stateSelector: 'button[aria-label*="Tools"]',
    },
    {
      id: 'toggle-reasoning',
      label: 'Reasoning model',
      kind: 'toggle',
      selector: '[data-testid="model-switcher"]',
      stateSelector: '[data-testid="model-switcher"]',
    },
  ],

  quietMs: 800,
  pollMs: 120,
  stepTimeoutMs: 10_000,
  transcriptLimit: 20,
};

export default chatgptSelectors;
