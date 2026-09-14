/**
 * DeepSeek Chat plugin.
 *
 * The website-specific knowledge lives in `selectors.ts`; everything else is
 * the generic `SelectorAdapter`. The small subclass below adds the two things
 * DeepSeek does differently: it shows a "thinking" phase before the answer and
 * it renders site errors inline.
 */
import {
  PageUnavailableError,
  SelectorAdapter,
  createPlugin,
  joinSelectors,
  type BrowserAIPlugin,
  type PluginContext,
  type WaitForResponseOptions,
  type WorkerStatus,
} from '@browsermind/core/browser';
import { deepseekSelectors } from './selectors.js';

export class DeepSeekAdapter extends SelectorAdapter {
  constructor(context: PluginContext) {
    super(context, {
      pluginId: 'deepseek',
      capabilities: ['chat', 'file_upload', 'stop', 'new_chat', 'deep_think', 'search'],
      pack: deepseekSelectors,
      states: {
        ready: 'ready',
        busy: 'generating',
        blocked: 'login-required',
        waiting: 'loading',
      },
    });
  }

  override async getStatus(): Promise<WorkerStatus> {
    const status = await super.getStatus();
    if (status === 'ready' && deepseekSelectors.errorBanner) {
      const banner = await this.driver.query({ selector: joinSelectors(deepseekSelectors.errorBanner), visible: true });
      if (banner && /network|try again|failed/i.test(await this.driver.text(banner))) return 'error';
    }
    return status;
  }

  override async waitForResponse(options: WaitForResponseOptions = {}): Promise<string> {
    try {
      return await super.waitForResponse(options);
    } catch (error) {
      // DeepSeek sometimes reports quota errors in the composer instead of the
      // transcript; surface them as a page problem, not as a generic timeout.
      const banner = deepseekSelectors.errorBanner
        ? await this.driver.query({ selector: joinSelectors(deepseekSelectors.errorBanner), visible: true })
        : null;
      if (banner) {
        const text = await this.driver.text(banner);
        if (text) {
          throw new PageUnavailableError(`DeepSeek reported: ${text}`, { cause: (error as Error).message });
        }
      }
      throw error;
    }
  }
}

export const deepseekPlugin: BrowserAIPlugin = createPlugin({
  id: 'deepseek',
  name: 'DeepSeek Chat',
  version: '1.0.0',
  matchPatterns: ['https://chat.deepseek.com/*'],
  capabilities: ['chat', 'file_upload', 'stop', 'new_chat', 'deep_think', 'search'],
  description: 'Wraps chat.deepseek.com, including the R1 thinking phase and DeepThink toggles.',
  homepage: 'https://chat.deepseek.com',
  accent: '#4d6bfe',
  metadata: { source: 'builtin' },
  createAdapter: (context) => new DeepSeekAdapter(context),
});

export default deepseekPlugin;
