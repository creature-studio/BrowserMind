/**
 * `@browsermind/testing` — headless verification harness.
 *
 * ```ts
 * const site = createFakeSite({ provider: 'deepseek' });
 * const plugin = deepseekPlugin;
 * const adapter = plugin.createAdapter(contextForSite(site));
 * ```
 */
export * from './sites.js';
export * from './fake-site.js';
export * from './harness.js';
