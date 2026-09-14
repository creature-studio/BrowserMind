/**
 * Remote DOM driver.
 *
 * Exposes the very same `DomDriverLike` surface over an `RpcPeer`, so an
 * adapter running *outside* the page (sandboxed third-party plugin, headless
 * runtime driver, test harness) can drive a real page through:
 *
 *   sandbox ──postMessage──▶ extension background ──port──▶ content script ──▶ DOM
 *
 * `serveDomDriver` is the other half and runs wherever the DOM actually lives.
 */
import type { DomDriverLike, ExecutionLocation } from '../types.js';
import type { RpcPeer } from '../rpc.js';

export const DOM_RPC_METHODS = [
  'query',
  'queryAll',
  'count',
  'exists',
  'text',
  'attr',
  'value',
  'isVisible',
  'click',
  'type',
  'press',
  'check',
  'scrollIntoView',
  'upload',
  'waitFor',
  'observeText',
  'info',
] as const;

export type DomRpcMethod = (typeof DOM_RPC_METHODS)[number];

export const DOM_RPC_PREFIX = 'dom.';

export interface RemoteDriverOptions {
  prefix?: string;
  location?: ExecutionLocation | 'remote';
  /** Per-call timeout; observe/dialog calls can be long, keep the default generous. */
  timeoutMs?: number;
}

export function createRemoteDomDriver(peer: RpcPeer, options: RemoteDriverOptions = {}): DomDriverLike {
  const prefix = options.prefix ?? DOM_RPC_PREFIX;
  const call = <T>(method: DomRpcMethod, params: unknown[], timeoutMs?: number): Promise<T> =>
    peer.request<T>(`${prefix}${method}`, params, timeoutMs ?? options.timeoutMs ?? 0) as Promise<T>;

  return {
    location: options.location ?? 'remote',
    query: (optionsArg) => call('query', [optionsArg]),
    queryAll: (optionsArg) => call('queryAll', [optionsArg]),
    count: (optionsArg) => call('count', [optionsArg]),
    exists: (optionsArg) => call('exists', [optionsArg]),
    text: (target, textOptions) => call('text', [target, textOptions]),
    attr: (target, name) => call('attr', [target, name]),
    value: (target) => call('value', [target]),
    isVisible: (target) => call('isVisible', [target]),
    click: (target, clickOptions) => call('click', [target, clickOptions]),
    type: (target, text, typeOptions) => call('type', [target, text, typeOptions]),
    press: (target, key, pressOptions) => call('press', [target, key, pressOptions]),
    check: (target, checked) => call('check', [target, checked]),
    scrollIntoView: (target) => call('scrollIntoView', [target]),
    upload: (target, files) => call('upload', [target, files]),
    waitFor: (selector, waitOptions) => call('waitFor', [selector, waitOptions]),
    observeText: (target, observeOptions) => call('observeText', [target, observeOptions]),
    info: () => call('info', []),
  };
}

/** Register a local driver on a peer so remote adapters can use it. */
export function serveDomDriver(peer: RpcPeer, driver: DomDriverLike, options: { prefix?: string } = {}): void {
  const prefix = options.prefix ?? DOM_RPC_PREFIX;
  peer.handle(`${prefix}query`, ([params]) => driver.query(params));
  peer.handle(`${prefix}queryAll`, ([params]) => driver.queryAll(params));
  peer.handle(`${prefix}count`, ([params]) => driver.count(params));
  peer.handle(`${prefix}exists`, ([params]) => driver.exists(params));
  peer.handle(`${prefix}text`, ([params, opts]) => driver.text(params, opts));
  peer.handle(`${prefix}attr`, ([target, name]) => driver.attr(target, name));
  peer.handle(`${prefix}value`, ([target]) => driver.value(target));
  peer.handle(`${prefix}isVisible`, ([target]) => driver.isVisible(target));
  peer.handle(`${prefix}click`, ([target, opts]) => driver.click(target, opts));
  peer.handle(`${prefix}type`, ([target, text, opts]) => driver.type(target, text, opts));
  peer.handle(`${prefix}press`, ([target, key, opts]) => driver.press(target, key, opts));
  peer.handle(`${prefix}check`, ([target, checked]) => driver.check(target, checked));
  peer.handle(`${prefix}scrollIntoView`, ([target]) => driver.scrollIntoView(target));
  peer.handle(`${prefix}upload`, ([target, files]) => driver.upload(target, files));
  peer.handle(`${prefix}waitFor`, ([selector, opts]) => driver.waitFor(selector, opts));
  peer.handle(`${prefix}observeText`, ([target, opts]) => {
    // Options carry no functions after a hop: forward only serializable fields.
    const safe = opts ? { ...opts, onProgress: undefined } : opts;
    return driver.observeText(target, safe);
  });
  peer.handle(`${prefix}info`, () => driver.info());
}
