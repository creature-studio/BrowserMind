/**
 * The runtime's tool-name API — one table, three transports.
 *
 * `tool-catalog.ts` already declares every operation an outside caller may use
 * together with its REST path. This module binds those names to `BrowserAIRuntime`
 * calls, so MCP, `browsermind serve`'s HTTP API and the extension WebSocket all
 * answer *exactly* the same methods with the same parameters:
 *
 *   MCP client      → `browser_ai_send_message`  (tool call)
 *   dashboard/page  → `POST /api/send_message`   (same handler, same params)
 *   extension pages → `runtime.request('browser_ai_send_message', …)`
 *
 * Parameters are accepted in snake_case (the MCP/JSON convention) *and*
 * camelCase, and booleans/numbers may arrive as strings because query
 * parameters do. Normalising that once here keeps every client simple.
 */
import { NotFoundError, toErrorPayload, type FileUpload, type PluginManifest } from '@browsermind/core';
import type { BrowserAIRuntime } from './runtime.js';
import { AGENT_GUIDE, TOOL_NAMES, toolCatalog } from './tool-catalog.js';

export type RpcParams = Record<string, unknown> | null | undefined;

export interface RuntimeApi {
  /** Every `browser_ai_*` name this API answers. */
  readonly methodNames: string[];
  /** Run one operation; failures throw, each transport formats them its own way. */
  call(method: string, params?: RpcParams): Promise<unknown>;
  /** REST path served for a tool name (`toolCatalog[].http`). */
  pathFor(method: string): string | undefined;
  /** Tool name behind a REST path. */
  methodFor(path: string): string | undefined;
}

/* ----------------------------- param plumbing ----------------------------- */

function raw(params: RpcParams, ...keys: string[]): unknown {
  if (!params || typeof params !== 'object') return undefined;
  for (const key of keys) {
    const value = (params as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringParam(params: RpcParams, ...keys: string[]): string | undefined {
  const value = raw(params, ...keys);
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function booleanParam(params: RpcParams, ...keys: string[]): boolean | undefined {
  const value = raw(params, ...keys);
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function numberParam(params: RpcParams, ...keys: string[]): number | undefined {
  const value = raw(params, ...keys);
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fileParam(params: RpcParams): FileUpload[] | undefined {
  const value = raw(params, 'files');
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const file = (entry ?? {}) as Record<string, unknown>;
    return {
      name: String(file.name ?? 'attachment.txt'),
      text: typeof file.text === 'string' ? file.text : undefined,
      base64: typeof file.base64 === 'string' ? file.base64 : undefined,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined,
    } satisfies FileUpload;
  });
}

/* -------------------------------- the table -------------------------------- */

type Handler = (params: RpcParams) => unknown | Promise<unknown>;

/** Every tool name → its implementation. Derived from the catalog, never beside it. */
function handlers(runtime: BrowserAIRuntime): Record<string, Handler> {
  return {
    [TOOL_NAMES.health]: () => runtime.status(),

    [TOOL_NAMES.listWorkers]: (params) => {
      const provider = stringParam(params, 'provider');
      const workers = runtime.listWorkers();
      return provider ? workers.filter((worker) => worker.provider === provider) : workers;
    },

    [TOOL_NAMES.listPlugins]: () => runtime.listPlugins(),

    [TOOL_NAMES.sendMessage]: async (params) => {
      const message = stringParam(params, 'message', 'prompt');
      if (!message) throw new Error('`message` is required');
      const wait = booleanParam(params, 'wait');
      const result = await runtime.sendMessage({
        worker: stringParam(params, 'worker'),
        provider: stringParam(params, 'provider'),
        message,
        wait,
        timeoutMs: numberParam(params, 'timeout_ms', 'timeoutMs'),
        newChat: booleanParam(params, 'new_chat', 'newChat'),
        files: fileParam(params),
      });
      return {
        worker: result.workerId,
        taskId: result.taskId,
        status: wait === false ? 'accepted' : 'completed',
        response: result.response,
        durationMs: result.durationMs,
      };
    },

    [TOOL_NAMES.getResponse]: (params) =>
      runtime.getResponse({
        worker: stringParam(params, 'worker'),
        provider: stringParam(params, 'provider'),
        taskId: stringParam(params, 'task_id', 'taskId'),
        wait: booleanParam(params, 'wait'),
        timeoutMs: numberParam(params, 'timeout_ms', 'timeoutMs'),
      }),

    [TOOL_NAMES.snapshot]: (params) =>
      runtime.snapshot({
        worker: stringParam(params, 'worker'),
        provider: stringParam(params, 'provider'),
        transcript: booleanParam(params, 'transcript') ?? true,
      }),

    [TOOL_NAMES.openWorker]: (params) =>
      runtime.openWorker({
        provider: stringParam(params, 'provider'),
        url: stringParam(params, 'url'),
        reuse: booleanParam(params, 'reuse') ?? true,
      }),

    [TOOL_NAMES.closeWorker]: (params) => {
      const worker = stringParam(params, 'worker', 'id');
      if (!worker) throw new Error('`worker` is required');
      return runtime.closeWorker(worker);
    },

    [TOOL_NAMES.stopWorker]: (params) => {
      const worker = stringParam(params, 'worker', 'id');
      if (!worker) throw new Error('`worker` is required');
      return runtime.stopWorker(worker);
    },

    [TOOL_NAMES.newChat]: (params) => {
      const worker = stringParam(params, 'worker', 'id');
      if (!worker) throw new Error('`worker` is required');
      return runtime.newChat(worker);
    },

    [TOOL_NAMES.invokeAction]: (params) => {
      const worker = stringParam(params, 'worker', 'id');
      const actionId = stringParam(params, 'action_id', 'actionId');
      if (!worker) throw new Error('`worker` is required');
      if (!actionId) throw new Error('`action_id` is required');
      return runtime.invoke(worker, actionId, raw(params, 'value'));
    },

    [TOOL_NAMES.installPlugin]: (params) => {
      const manifest = raw(params, 'manifest', 'plugin') ?? params ?? undefined;
      if (!manifest) throw new Error('`manifest` is required');
      return runtime.installPlugin(manifest as PluginManifest | string, {
        persist: booleanParam(params, 'persist') ?? false,
        // Replacing is the friendly default for a UI that re-submits the same manifest.
        replace: booleanParam(params, 'replace') ?? true,
      });
    },

    [TOOL_NAMES.workerContext]: () => ({
      guide: AGENT_GUIDE,
      tools: toolCatalog.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, http: tool.http })),
      workers: runtime.listWorkers(),
      plugins: runtime.listPlugins(),
      extension: runtime.status().extension,
    }),
  };
}

const pathByName = new Map<string, string>(toolCatalog.map((tool) => [tool.name, tool.http]));
const nameByPath = new Map<string, string>(toolCatalog.map((tool) => [tool.http, tool.name]));

export function createRuntimeApi(runtime: BrowserAIRuntime): RuntimeApi {
  const table = handlers(runtime);
  return {
    methodNames: Object.keys(table),
    async call(method, params) {
      const handler = table[method];
      if (!handler) {
        throw new NotFoundError(`Unknown method "${method}"`, {
          available: Object.keys(table),
          http: method.replace(/^browser_ai_/, '/api/'),
        });
      }
      return handler(params);
    },
    pathFor: (method) => pathByName.get(method),
    methodFor: (path) => nameByPath.get(path),
  };
}

/**
 * Format an `api.call` failure the way HTTP clients expect it. Kept separate
 * from the RPC path (where `RpcPeer` serialises typed errors itself).
 */
export function httpErrorPayload(error: unknown): { status: number; body: { error: string; message: string } } {
  const payload = toErrorPayload(error);
  const status = payload.code === 'not_found' ? 404 : payload.code === 'validation_error' ? 422 : 400;
  return { status, body: { error: payload.code, message: payload.message } };
}
