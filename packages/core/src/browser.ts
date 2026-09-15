/**
 * Browser-safe core entry point.
 *
 * Everything a content script, an extension page, a sandbox or a plugin may import.
 * Node-only modules (plugin loader, file system access) live in the main entry
 * so bundlers never try to include `node:fs` in an extension.
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

export { createLocalDomDriver, createDomDriverFromWindow, type DomDriverEnvironment } from './dom/local-driver.js';
export {
  createRemoteDomDriver,
  serveDomDriver,
  DOM_RPC_METHODS,
  DOM_RPC_PREFIX,
  type DomRpcMethod,
  type RemoteDriverOptions,
} from './dom/remote.js';
export { SelectorAdapter, createSelectorAdapter, type SelectorAdapterOptions } from './adapter/selector-adapter.js';
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
