/**
 * Console contracts.
 *
 * The page is a plain client of the documented `browser_ai.*` surface, so it
 * mirrors the *shapes* it renders instead of importing Node-side packages — the
 * bundle must stay dependency-free to be inlined into a single HTML file and to
 * be mounted inside the extension as well.
 */

export type WorkerStatus = 'idle' | 'ready' | 'busy' | 'waiting' | 'blocked' | 'error' | 'offline';

export interface WorkerRow {
  id: string;
  provider: string;
  pluginName: string;
  status: WorkerStatus;
  capabilities: string[];
  url: string;
  title?: string;
  tabId?: number;
  sessionId: string;
  location: 'page' | 'sandbox' | 'simulator';
  lastError?: string;
  tasks: { total: number; completed: number; failed: number; current?: string };
}

export interface ActionRow {
  id: string;
  label: string;
  kind: 'click' | 'type' | 'toggle' | 'upload' | 'navigate' | 'chat';
  enabled: boolean;
  reason?: string;
  value?: boolean;
}

export interface TranscriptRow {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  at: number;
}

export interface SnapshotRow {
  workerId: string;
  provider: string;
  url: string;
  title?: string;
  state: string;
  status: WorkerStatus;
  capabilities: string[];
  availableActions: ActionRow[];
  transcript: TranscriptRow[];
  busy: boolean;
  at: number;
  meta?: Record<string, unknown>;
}

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  matchPatterns: string[];
  capabilities: string[];
  description?: string;
  source?: string;
  installedAt?: number;
}

export interface HealthRow {
  extension: { connected: number; port: number | null; clients: Array<{ id: string; connectedAt: number }> };
  workers: WorkerRow[];
  plugins: PluginRow[];
  simulated: string[];
}

/** A page the extension has attached — only visible to the extension host. */
export interface SessionRow {
  id: string;
  pluginId: string;
  url: string;
  title?: string;
  tabId?: number;
  location: string;
  attached: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
  taskId?: string;
  /** true while the answer is still streaming in. */
  streaming?: boolean;
  /** the provider stopped early (`partial`) or the task failed. */
  note?: string;
  durationMs?: number;
}

/** Frames the host forwards: SSE on the web, the bridge inside the extension. */
export interface ConsoleEvent {
  kind:
    | 'worker.added'
    | 'worker.updated'
    | 'worker.removed'
    | 'task.started'
    | 'task.progress'
    | 'task.completed'
    | 'task.failed'
    | string;
  payload: unknown;
}

/**
 * Everything the page needs from its host. Two implementations ship:
 * `HttpTransport` (same-origin REST + SSE) and `BridgeTransport` (the
 * extension's `runtime.request` RPC) — the UI above them is identical.
 */
export interface ConsoleTransport {
  kind: 'web' | 'extension';
  /** Shown in the header so you always know what the page is wired to. */
  readonly label: string;
  /** Call one documented tool. Rejects with `{ code, message }`-ish errors. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to live worker/task frames. Returns an unsubscribe function. */
  subscribe?(handler: (event: ConsoleEvent) => void): () => void;
  /** Ask the host to re-establish its link with the runtime. */
  reconnect?(): Promise<void>;
  /** Attached browser pages (extension host only — the runtime HTTP API has no tab list). */
  listSessions?(): Promise<SessionRow[]>;
  /** Per-tab action (extension host only). */
  tabAction?(action: 'focus' | 'close' | 'highlight', tabId: number): Promise<void>;
  /** Open a URL in a browser tab (both hosts, different mechanism). */
  openLink?(url: string): void;
}
