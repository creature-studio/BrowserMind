/**
 * claude.ai selector pack.
 *
 * Claude renders each answer as `.font-claude-message` (with the markdown body
 * inside) and shows a stop button while thinking. The composer is a
 * ProseMirror contenteditable field.
 */
import type { SelectorPack } from '@browsermind/core/browser';

export const claudeSelectors: SelectorPack = {
  input: [
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    '#claude-composer',
    'fieldset div[contenteditable="true"]',
  ],
  sendButton: ['button[aria-label="Send Message"]', 'button[aria-label="Send message"]'],
  submitKeys: ['Enter'],

  response: ['.font-claude-message .markdown', '.font-claude-message', '[data-testid="assistant-message"] .markdown'],
  streaming: ['.font-claude-message.streaming', 'button[aria-label="Stop response"]:not([hidden])'],
  busy: ['button[aria-label="Stop response"]:not([hidden])'],
  ready: ['div.ProseMirror[contenteditable="true"]'],
  blocked: ['.login-required:not([hidden])', '[data-testid="login-page"]'],

  fileInput: ['input.file-upload', 'input[type="file"]'],
  attachButton: ['button[aria-label*="pload"]', 'button[aria-label*="ttach"]'],

  newChat: ['button[aria-label="Start new chat"]', 'a[href="/new"]', 'button.new-chat'],
  stopButton: ['button[aria-label="Stop response"]:not([hidden])'],
  userMessage: ['.font-user-message', '[data-testid="user-message"]'],

  actions: [
    {
      id: 'toggle-extended-thinking',
      label: 'Extended thinking',
      kind: 'toggle',
      selector: 'button[aria-label*="thinking"]',
      stateSelector: 'button[aria-label*="thinking"]',
    },
    {
      id: 'select-style',
      label: 'Writing style',
      kind: 'click',
      selector: 'button[aria-label*="style"]',
    },
  ],

  quietMs: 800,
  pollMs: 120,
  stepTimeoutMs: 10_000,
  transcriptLimit: 20,
};

export default claudeSelectors;
