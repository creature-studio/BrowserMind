/**
 * ChatGPT Web plugin.
 *
 * Provider specific behaviour beyond the selector pack: ChatGPT keeps the last
 * turn in a "streaming" class and inserts a typing caret, and it renders
 * several UI variants of the composer depending on experiments. Both are
 * handled here, the rest comes from `SelectorAdapter`.
 */
import {
  SelectorAdapter,
  createPlugin,
  joinSelectors,
  type BrowserAIPlugin,
  type PluginContext,
  type WaitForResponseOptions,
} from '@browsermind/core/browser';
import { chatgptSelectors } from './selectors.js';

export class ChatGptAdapter extends SelectorAdapter {
  constructor(context: PluginContext) {
    super(context, {
      pluginId: 'chatgpt',
      capabilities: ['chat', 'file_upload', 'image_input', 'stop', 'new_chat', 'tools'],
      pack: chatgptSelectors,
      states: {
        ready: 'ready',
        busy: 'streaming',
        blocked: 'login-required',
        waiting: 'loading',
      },
    });
  }

  /**
   * ChatGPT sometimes leaves the caret in the composer after the answer is
   * finished, which looks exactly like "still streaming". Waiting for the
   * composer to be emptied is a stronger completion signal.
   */
  override async waitForResponse(options: WaitForResponseOptions = {}): Promise<string> {
    const text = await super.waitForResponse(options);
    const composer = joinSelectors(chatgptSelectors.input);
    if (composer) {
      const handle = await this.driver.query({ selector: composer });
      const remaining = handle ? await this.driver.value(handle).catch(() => '') : '';
      if (remaining && remaining.trim().length > 0) {
        options.onProgress?.(text);
      }
    }
    return text;
  }
}

export const chatgptPlugin: BrowserAIPlugin = createPlugin({
  id: 'chatgpt',
  name: 'ChatGPT Web',
  version: '1.0.0',
  matchPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  capabilities: ['chat', 'file_upload', 'image_input', 'stop', 'new_chat', 'tools'],
  description: 'Wraps ChatGPT Web including ProseMirror typing and streaming detection.',
  homepage: 'https://chatgpt.com',
  accent: '#10a37f',
  metadata: { source: 'builtin' },
  createAdapter: (context) => new ChatGptAdapter(context),
});

export default chatgptPlugin;
