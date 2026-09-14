/**
 * `@browsermind/core` — the provider-agnostic half of the system.
 *
 * Nothing in this package knows about DeepSeek, ChatGPT, Claude or Gemini.
 * Add a provider by adding a plugin folder; the core stays untouched.
 */
export * from './types.js';
export * from './errors.js';
export * from './events.js';
export * from './logger.js';
export * from './rpc.js';
export * from './ws-channel.js';
export * from './match-pattern.js';
export * from './registry.js';
export * from './session-provider.js';
export * from './worker-manager.js';
export * from './protocol.js';
export * from './local-sessions.js';
export * from './plugin-loader.js';

export { createLocalDomDriver, createDomDriverFromWindow, type DomDriverEnvironment } from './dom/local-driver.js';
export {
  createRemoteDomDriver,
  serveDomDriver,
  DOM_RPC_METHODS,
  DOM_RPC_PREFIX,
  type DomRpcMethod,
  type RemoteDriverOptions,
} from './dom/remote.js';
export {
  SelectorAdapter,
  createSelectorAdapter,
  type SelectorAdapterOptions,
} from './adapter/selector-adapter.js';
export {
  joinSelectors,
  extendPack,
  validatePack,
  DEFAULT_SUBMIT_KEYS,
  type SelectorPack,
  type SelectorAction,
} from './adapter/selectors.js';
export {
  createDeclarativePlugin,
  validateManifest,
  pluginFromManifestJson,
  type PluginManifest,
} from './plugins/declarative.js';
