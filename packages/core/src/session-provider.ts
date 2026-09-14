/**
 * Session providers.
 *
 * A `SessionProvider` is the bridge between "pages that exist somewhere" and
 * the `WorkerManager`. Implementations:
 *
 *   - `WebSocketSessionProvider` (runtime side): pages come from the extension.
 *   - `LocalSessionProvider` (simulator / tests): pages are created in-process.
 *
 * The worker manager does not care which one is active, which is what allows
 * the entire system to be developed and tested without a browser.
 */
import { Emitter } from './events.js';
import type { ExecutionLocation, Logger, PageSession, PluginId } from './types.js';

export interface SessionEvents {
  added: { session: PageSession };
  removed: { sessionId: string; reason?: string };
  updated: { session: PageSession };
  attached: { sessions: PageSession[] };
  detached: { reason?: string };
}

export interface OpenSessionRequest {
  url?: string;
  provider?: PluginId;
  /** Reuse an existing matching page instead of creating a new one. */
  reuse?: boolean;
  active?: boolean;
}

export interface SessionProvider {
  readonly kind: ExecutionLocation;
  readonly events: Emitter<SessionEvents>;
  /** Connect (idempotent) and return the current sessions. */
  connect(): Promise<PageSession[]>;
  disconnect?(): Promise<void>;
  /** Bring a page into existence for the requested provider/url. */
  open(request: OpenSessionRequest): Promise<PageSession>;
  close(sessionId: string): Promise<void>;
  navigate?(sessionId: string, url: string): Promise<void>;
  reload?(sessionId: string): Promise<void>;
  focus?(sessionId: string): Promise<void>;
  /** Optional sink for transport-level diagnostics. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}
