/**
 * chat.deepseek.com selector pack.
 *
 * ⚠️ Websites change. When DeepSeek ships a new composer, this is the *only*
 * file that needs updating — no core code, no runtime redeploy.
 * Each list is ordered by preference; the first visible match wins.
 */
import type { SelectorPack } from '@browsermind/core/browser';

export const deepseekSelectors: SelectorPack = {
  input: [
    '#chat-input',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="发消息"]',
    '.ds-textarea',
    'textarea',
  ],
  sendButton: [
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label="发送"]',
    '.ds-send-button',
    'button[aria-label*="Send"]',
  ],
  submitKeys: ['Enter'],

  // One element per answer (markdown body of an assistant bubble).
  response: [
    '.ds-message[data-role="assistant"] .ds-markdown',
    '[class*="ds-markdown"]',
  ],
  streaming: [
    '.ds-generating',
    '.ds-stop-button:not([hidden])',
    '.ds-loading',
  ],
  busy: ['.ds-send-button[aria-disabled="true"]', 'button[aria-disabled="true"]'],
  ready: ['#chat-input', '.ds-textarea'],
  blocked: [
    '.ds-login-modal:not([hidden])',
    '.ds-sign-in-modal:not([hidden])',
    '[class*="login-modal"]:not([hidden])',
  ],
  errorBanner: ['[class*="error-text"]', '.ds-error'],

  fileInput: ['input.ds-file-input', 'input[type="file"]'],
  attachButton: ['[class*="attach"]', 'div[role="button"][aria-label*="ttach"]'],

  newChat: ['.ds-new-chat', '[class*="new-chat"]', 'div[role="button"][aria-label*="New chat"]'],
  stopButton: ['.ds-stop-button:not([hidden])'],
  userMessage: ['.ds-message[data-role="user"] .ds-user-content', '[class*="ds-user-content"]'],

  actions: [
    {
      id: 'toggle-deep-think',
      label: 'DeepThink (R1 reasoning)',
      kind: 'toggle',
      selector: '.ds-deep-think',
      stateSelector: '.ds-deep-think',
      description: 'Switches the model into its reasoning mode.',
    },
    {
      id: 'toggle-search',
      label: 'Web search',
      kind: 'toggle',
      selector: '[class*="search-toggle"]',
      stateSelector: '[class*="search-toggle"]',
    },
  ],

  quietMs: 700,
  pollMs: 120,
  stepTimeoutMs: 10_000,
  transcriptLimit: 20,
};

export default deepseekSelectors;
