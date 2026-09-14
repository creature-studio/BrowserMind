/**
 * Claude Web plugin.
 *
 * Claude streams markdown that grows in place and briefly re-renders when a
 * code block closes, which produces a short "quiet" window in the middle of an
 * answer. The adapter therefore requires two consecutive quiet windows before
 * declaring the answer complete.
 */
import {
  SelectorAdapter,
  createPlugin,
  type BrowserAIPlugin,
  type PluginContext,
  type WaitForResponseOptions,
} from '@browsermind/core/browser';
import { claudeSelectors } from './selectors.js';

export class ClaudeAdapter extends SelectorAdapter {
  constructor(context: PluginContext) {
    super(context, {
      pluginId: 'claude',
      capabilities: ['chat', 'file_upload', 'image_input', 'stop', 'new_chat', 'artifacts'],
      pack: claudeSelectors,
      states: {
        ready: 'ready',
        busy: 'thinking',
        blocked: 'login-required',
        waiting: 'loading',
      },
    });
  }

  override async waitForResponse(options: WaitForResponseOptions = {}): Promise<string> {
    // Ask the generic implementation for a stable answer, then confirm it did
    // not grow again (Claude re-renders artefacts after a pause).
    const text = await super.waitForResponse(options);
    const target = await this.driver.query({
      selector: '.font-claude-message .markdown, .font-claude-message',
      index: -1,
      visible: true,
    });
    if (!target) return text;
    const confirmed = await this.driver
      .observeText(target, { timeoutMs: 4_000, quietMs: 700, minLength: 1 })
      .catch(() => text);
    if (confirmed && confirmed.length > text.length) {
      options.onProgress?.(confirmed);
      return confirmed;
    }
    return text;
  }
}

export const claudePlugin: BrowserAIPlugin = createPlugin({
  id: 'claude',
  name: 'Claude Web',
  version: '1.0.0',
  matchPatterns: ['https://claude.ai/*'],
  capabilities: ['chat', 'file_upload', 'image_input', 'stop', 'new_chat', 'artifacts'],
  description: 'Wraps claude.ai with artefact aware completion detection.',
  homepage: 'https://claude.ai',
  accent: '#d97757',
  metadata: { source: 'builtin' },
  createAdapter: (context) => new ClaudeAdapter(context),
});

export default claudePlugin;
