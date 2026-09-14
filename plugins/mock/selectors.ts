/**
 * Selector pack for the mock provider.
 *
 * A selector pack is the complete website knowledge of a plugin. Fields are
 * lists of candidates: the first *visible* match wins, so one pack keeps
 * working across several UI variants of the same site.
 */
import type { SelectorPack } from '@browsermind/core/browser';

export const mockSelectors: SelectorPack = {
  // Composer
  input: ['#prompt-input', 'textarea.mock-input', 'textarea'],
  sendButton: ['#send-button', 'button[aria-label="Send message"]'],
  submitKeys: ['Enter'],

  // Answers: one element per AI message — the last visible match is the newest.
  response: ['.message.assistant .mock-markdown', '.mock-markdown'],
  streaming: ['#generating', '#stop-button:not([hidden])'],
  busy: ['#send-button:disabled', '#send-button[aria-disabled="true"]'],
  ready: ['#prompt-input'],
  blocked: ['#login-wall'],
  errorBanner: ['.error-banner'],

  // Attachments
  fileInput: ['#file-input'],
  attachButton: ['#attach'],

  // Chat management
  newChat: ['#new-chat'],
  stopButton: ['#stop-button:not([hidden])'],
  userMessage: ['.message.user .user-bubble'],

  actions: [
    {
      id: 'toggle-fast-mode',
      label: 'Fast mode',
      kind: 'toggle',
      selector: '.fast-mode-toggle',
      stateSelector: '.fast-mode-toggle',
    },
  ],

  quietMs: 250,
  pollMs: 60,
  stepTimeoutMs: 4_000,
  transcriptLimit: 10,
};

export default mockSelectors;
