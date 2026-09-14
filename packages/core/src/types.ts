/**
 * BrowserMind core protocol types.
 *
 * Everything in this file is transport agnostic and shared by:
 *  - the Runtime (worker management + MCP)
 *  - the Extension (page injection + DOM operations + plugin execution)
 *  - plugins (adapters running in a page, a sandbox or a simulator)
 *
 * The golden rule of this project: an Agent never sees the web page.
 * It sees a Worker, a Status and a Snapshot. Selectors never leak out of a plugin.
 */

/**
 * Declarative plugin manifest: metadata + selector pack. A provider can be
 * shipped as nothing more than this JSON object.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  matchPatterns: string[];
  capabilities?: string[];
  description?: string;
  homepage?: string;
  author?: string;
  accent?: string;
  selectors?: import('./adapter/selectors.js').SelectorPack;
  /** Optional labels for page states. */
  states?: Record<string, string>;
  /** Assistant personality used by the MCP `worker_context` tool. */
  instructions?: string;
}

/** Identifier of a provider plugin, e.g. `deepseek`, `chatgpt`. */
export type PluginId = string;

/** Stable worker id, e.g. `deepseek-1`. */
export type WorkerId = string;

/** Lifecycle state of a worker / page. */
export type WorkerStatus =
  | 'idle' // session created, adapter not attached yet
  | 'ready' // page is usable, waiting for instruction
  | 'busy' // a message was submitted, the AI is working
  | 'waiting' // worker accepted a task but the page is not usable yet (loading / needs login)
  | 'blocked' // page is unusable: login wall, quota wall, captcha
  | 'error' // last operation failed
  | 'offline'; // tab closed / browser disconnected

/** Where a session's adapter actually executes. */
export type ExecutionLocation = 'page' | 'sandbox' | 'simulator';

/** Kinds of actions a page can offer, discovered by the plugin. */
export type ActionKind = 'click' | 'type' | 'toggle' | 'upload' | 'navigate' | 'chat';

export interface ActionDescriptor {
  /** Stable id used with `worker.invoke()` — never a CSS selector. */
  id: string;
  label: string;
  kind: ActionKind;
  enabled: boolean;
  reason?: string;
  /** Value of a toggle action. */
  value?: boolean;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  at: number;
}

/**
 * What the external agent is allowed to know about a page.
 * Deliberately free of DOM details.
 */
export interface PageSnapshot {
  workerId: WorkerId;
  provider: PluginId;
  url: string;
  title?: string;
  /** Human readable page state, e.g. `ready`, `generating`, `login-required`. */
  state: string;
  status: WorkerStatus;
  capabilities: string[];
  availableActions: ActionDescriptor[];
  transcript: TranscriptEntry[];
  busy: boolean;
  at: number;
  meta?: Record<string, unknown>;
}

/** A resource the agent can attach to a message (uploaded through the page's own UI). */
export interface FileUpload {
  name: string;
  /** Base64 payload (no data: prefix). */
  base64?: string;
  /** Plain text shortcut: encoded to a text file named `name`. */
  text?: string;
  mimeType?: string;
}

export interface SendMessageOptions {
  /** Wait for the reply instead of returning as soon as the message is submitted. */
  waitForResponse?: boolean;
  timeoutMs?: number;
  /** Return a partial answer on timeout instead of failing the task. */
  partial?: boolean;
  files?: FileUpload[];
  /** Optional free-form instructions for the plugin (e.g. `{ newChat: true }`). */
  options?: Record<string, unknown>;
}

export interface SendMessageResult {
  workerId: WorkerId;
  taskId: string;
  acceptedAt: number;
  /** Present when `waitForResponse` was requested. */
  response?: string;
  durationMs?: number;
}

export interface ResponseResult {
  workerId: WorkerId;
  taskId: string;
  response: string;
  durationMs: number;
  at: number;
  /** true when the answer was still streaming (or ended) when the deadline hit. */
  partial?: boolean;
}

/** A worker is the only thing an agent manipulates. */
export interface WorkerDescriptor {
  id: WorkerId;
  provider: PluginId;
  pluginName: string;
  status: WorkerStatus;
  capabilities: string[];
  url: string;
  title?: string;
  tabId?: number;
  sessionId: string;
  location: ExecutionLocation;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  tasks: { total: number; completed: number; failed: number; current?: string };
}

/* -------------------------------------------------------------------------- */
/* Plugin contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A plugin is a pure declaration: it matches URLs, announces capabilities and
 * knows how to build an adapter. Core code never branches on a provider id.
 */
export interface BrowserAIPlugin {
  readonly id: PluginId;
  readonly name: string;
  readonly version: string;
  /** chrome/webextension style match patterns, e.g. `https://chat.deepseek.com/*`. */
  match(url: string): boolean;
  capabilities(): string[];
  createAdapter(context: PluginContext): AIAdapter;
  /** Optional one-line description shown in the catalog. */
  describe(): PluginDescriptor;
  /** Present for declarative plugins: the manifest they were built from. */
  readonly manifest?: PluginManifest;
}

export interface PluginDescriptor {
  id: PluginId;
  name: string;
  version: string;
  matchPatterns: string[];
  capabilities: string[];
  description?: string;
  homepage?: string;
  author?: string;
  /** Where the plugin came from — builtin folder, installed JSON, or third-party bundle. */
  source?: PluginSourceKind;
  installedAt?: number;
  enabled?: boolean;
  /** Provider colour used by dashboards. */
  accent?: string;
}

export type PluginSourceKind = 'builtin' | 'declarative' | 'remote';

/** Everything a plugin may use while running. */
export interface PluginContext {
  /** Channel used to touch the page. Local (fast path) or remote (sandbox). */
  driver: DomDriverLike;
  logger: Logger;
  /** Cooperative cancellation (user hit stop / runtime shutdown). */
  signal?: AbortSignal;
  /** Injected clock so plugins stay testable. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Free-form options handed over by the agent (`send_message.options`). */
  config?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Adapter contract                                                           */
/* -------------------------------------------------------------------------- */

export interface WaitForResponseOptions {
  timeoutMs?: number;
  /** Return the partial text instead of throwing when the timeout hits. */
  partial?: boolean;
  /** Called for every text delta while streaming (enables live progress). */
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * One adapter per page. This is the *only* interface plugins must implement —
 * and most plugins get a working one for free from `SelectorAdapter`.
 */
export interface AIAdapter {
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
  waitForResponse(options?: WaitForResponseOptions): Promise<string>;
  getStatus(): Promise<WorkerStatus>;
  snapshot(): Promise<PageSnapshot>;
  /** Sync for in-page adapters, async when the adapter lives behind a wire. */
  capabilities(): string[] | Promise<string[]>;
  /** Optional extras implemented by capable plugins. */
  stop?(): Promise<void>;
  newChat?(): Promise<void>;
  invoke?(actionId: string, value?: unknown): Promise<unknown>;
  transcript?(): Promise<TranscriptEntry[]>;
}

/* -------------------------------------------------------------------------- */
/* DOM driver contract                                                        */
/* -------------------------------------------------------------------------- */
/*
 * Adapters never touch `document` directly. They talk to a `DomDriver`, which
 * can be:
 *   - local:  the page itself (content script / simulator)  → ~0 overhead
 *   - remote: a postMessage / port / websocket proxy (sandbox, headless)
 * That single indirection is what makes plugins portable across execution
 * contexts and headlessly testable.
 */

export interface ElementHandle {
  ref: string;
  tag?: string;
  text?: string;
}

export type Target = ElementHandle | string;

export interface QueryOptions {
  selector: string;
  index?: number;
  visible?: boolean;
  timeoutMs?: number;
  /** Search inside another element instead of the document. */
  root?: Target;
}

export type WaitState = 'attached' | 'visible' | 'hidden' | 'detached';

export interface WaitForOptions {
  timeoutMs?: number;
  pollMs?: number;
  state?: WaitState;
  signal?: AbortSignal;
}

export interface TypeOptions {
  /** How to put text into the field. `auto` sniffs the element type. */
  mode?: 'auto' | 'value' | 'insertText' | 'keys';
  clear?: boolean;
  delayMs?: number;
  submit?: boolean;
  signal?: AbortSignal;
}

export interface ObserveOptions {
  timeoutMs?: number;
  /** Resolve after the text stayed the same for this long. */
  quietMs?: number;
  /** Do not resolve before this many characters arrived. */
  minLength?: number;
  pollMs?: number;
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

export interface DomDriverLike {
  readonly location: ExecutionLocation | 'local' | 'remote';
  query(options: QueryOptions): Promise<ElementHandle | null>;
  queryAll(options: QueryOptions): Promise<ElementHandle[]>;
  count(options: QueryOptions): Promise<number>;
  exists(options: QueryOptions): Promise<boolean>;
  text(target: Target, options?: { timeoutMs?: number; trim?: boolean }): Promise<string>;
  attr(target: Target, name: string): Promise<string | null>;
  value(target: Target): Promise<string>;
  isVisible(target: Target): Promise<boolean>;
  click(target: Target, options?: { timeoutMs?: number }): Promise<void>;
  type(target: Target, text: string, options?: TypeOptions): Promise<void>;
  press(target: Target | null, key: string, options?: { submit?: boolean }): Promise<void>;
  check(target: Target, checked: boolean): Promise<void>;
  scrollIntoView(target: Target): Promise<void>;
  upload(target: Target, files: FileUpload[]): Promise<number>;
  waitFor(selector: string, options?: WaitForOptions): Promise<ElementHandle | null>;
  /** Wait until `target` text stops changing (streaming detector). */
  observeText(target: Target, options?: ObserveOptions): Promise<string>;
  info(): Promise<{ url: string; title: string }>;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/** A live page bound to a plugin. Sessions are reported by the extension or created by the simulator. */
export interface PageSession {
  id: string;
  pluginId: PluginId;
  url: string;
  title?: string;
  tabId?: number;
  capabilities: string[];
  location: ExecutionLocation;
  adapter: AIAdapter;
  /** Present when raw DOM calls may be tunnelled (third-party sandboxed plugins). */
  domDriver?: DomDriverLike;
  close?(): Promise<void>;
  navigate?(url: string): Promise<void>;
  reload?(): Promise<void>;
  focus?(): Promise<void>;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}
