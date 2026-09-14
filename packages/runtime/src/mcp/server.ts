/**
 * MCP server — the agent-facing surface.
 *
 * Tools are thin adapters over `BrowserAIRuntime`, so the same operations are
 * available over MCP, HTTP and the CLI. Nothing provider-specific ever appears
 * here: the agent sees workers, statuses and snapshots only.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toErrorPayload, type FileUpload } from '@browsermind/core';
import type { BrowserAIRuntime } from '../runtime.js';
import { AGENT_GUIDE, TOOL_NAMES, toolCatalog } from '../tool-catalog.js';

export interface McpServerOptions {
  runtime: BrowserAIRuntime;
  name?: string;
  version?: string;
  /** Print MCP traffic to the runtime logger. */
  verbose?: boolean;
}

export interface McpServerHandle {
  server: McpServer;
  /** Connect over stdio — what `browsermind mcp` uses. */
  connectStdio(): Promise<void>;
  close(): Promise<void>;
}

const fileSchema = z.object({
  name: z.string().describe('File name, e.g. "notes.md"'),
  text: z.string().optional().describe('Plain text content (the usual choice)'),
  base64: z.string().optional().describe('Base64 content for binary files'),
  mimeType: z.string().optional(),
});

function json(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const payload = toErrorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `[${payload.code}] ${payload.message}` }],
  };
}

export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const { runtime } = options;
  const server = new McpServer(
    { name: options.name ?? 'browsermind', version: options.version ?? '0.1.0' },
    { instructions: AGENT_GUIDE },
  );

  server.registerTool(
    TOOL_NAMES.health,
    {
      title: 'Runtime health',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.health)!.description,
      inputSchema: {},
    },
    async () => {
      try {
        const status = runtime.status();
        return json({
          ok: status.workers.length > 0,
          extension: status.extension,
          simulated: status.simulated,
          workers: status.workers.length,
          plugins: status.plugins.length,
          workerIds: status.workers.map((worker) => worker.id),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.listWorkers,
    {
      title: 'List browser AI workers',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.listWorkers)!.description,
      inputSchema: {
        provider: z.string().optional().describe('Only show workers of this provider'),
      },
    },
    async ({ provider }) => {
      try {
        const workers = runtime
          .listWorkers()
          .filter((worker) => !provider || worker.provider === provider)
          .map((worker) => ({
            id: worker.id,
            provider: worker.provider,
            plugin: worker.pluginName,
            status: worker.status,
            capabilities: worker.capabilities,
            url: worker.url,
            title: worker.title,
            location: worker.location,
            tasks: worker.tasks,
            lastError: worker.lastError,
          }));
        return json(workers);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.sendMessage,
    {
      title: 'Send a message to a worker',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.sendMessage)!.description,
      inputSchema: {
        message: z.string().describe('The prompt to send'),
        worker: z.string().optional().describe('Worker id, e.g. "deepseek-1"'),
        provider: z.string().optional().describe('Provider id, e.g. "deepseek" (uses the newest matching worker)'),
        wait: z.boolean().optional().describe('Wait for the answer (default true)'),
        timeout_ms: z.number().int().positive().optional().describe('Answer timeout, default 180000'),
        new_chat: z.boolean().optional().describe('Start a fresh conversation before sending'),
        files: z.array(fileSchema).optional().describe('Attachments uploaded through the page UI'),
      },
    },
    async ({ message, worker, provider, wait, timeout_ms, new_chat, files }) => {
      try {
        const files_ = (files ?? []).map(
          (file) => ({ name: file.name, text: file.text, base64: file.base64, mimeType: file.mimeType }) satisfies FileUpload,
        );
        const result = await runtime.sendMessage({
          worker,
          provider,
          message,
          wait,
          timeoutMs: timeout_ms,
          newChat: new_chat,
          files: files_,
        });
        const descriptor = runtime.listWorkers().find((candidate) => candidate.id === result.workerId);
        return json({
          worker: result.workerId,
          provider: descriptor?.provider,
          taskId: result.taskId,
          status: wait === false ? 'accepted' : 'completed',
          durationMs: result.durationMs,
          response: result.response,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.getResponse,
    {
      title: 'Read a worker response',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.getResponse)!.description,
      inputSchema: {
        worker: z.string().optional(),
        provider: z.string().optional(),
        task_id: z.string().optional().describe('Specific task id; defaults to the newest task'),
        wait: z.boolean().optional().describe('Wait for the running task to finish (default true)'),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ worker, provider, task_id, wait, timeout_ms }) => {
      try {
        const result = await runtime.getResponse({ worker, provider, taskId: task_id, wait, timeoutMs: timeout_ms });
        return json(result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.snapshot,
    {
      title: 'Snapshot a worker page',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.snapshot)!.description,
      inputSchema: {
        worker: z.string().optional(),
        provider: z.string().optional(),
        transcript: z.boolean().optional().describe('Include the conversation transcript (default true)'),
      },
    },
    async ({ worker, provider, transcript }) => {
      try {
        const snapshot = await runtime.snapshot({ worker, provider, transcript });
        return json({
          worker: snapshot.workerId,
          provider: snapshot.provider,
          url: snapshot.url,
          title: snapshot.title,
          state: snapshot.state,
          status: snapshot.status,
          capabilities: snapshot.capabilities,
          availableActions: snapshot.availableActions,
          busy: snapshot.busy,
          transcript: snapshot.transcript.map((entry) => ({
            role: entry.role,
            text: entry.text.length > 2000 ? `${entry.text.slice(0, 2000)}…` : entry.text,
          })),
          meta: snapshot.meta,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.listPlugins,
    {
      title: 'List provider plugins',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.listPlugins)!.description,
      inputSchema: {},
    },
    async () => {
      try {
        return json(
          runtime.listPlugins().map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            source: plugin.source,
            enabled: plugin.enabled ?? true,
            matchPatterns: plugin.matchPatterns,
            capabilities: plugin.capabilities,
            description: plugin.description,
          })),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.openWorker,
    {
      title: 'Open a worker',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.openWorker)!.description,
      inputSchema: {
        provider: z.string().optional().describe('Provider id to open'),
        url: z.string().optional().describe('Explicit URL (must match an installed plugin)'),
        reuse: z.boolean().optional().describe('Reuse an existing matching worker (default true)'),
      },
    },
    async ({ provider, url, reuse }) => {
      try {
        return json(await runtime.openWorker({ provider, url, reuse }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.closeWorker,
    {
      title: 'Close a worker',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.closeWorker)!.description,
      inputSchema: { worker: z.string().describe('Worker id') },
    },
    async ({ worker }) => {
      try {
        return json(await runtime.closeWorker(worker));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.stopWorker,
    {
      title: 'Stop a worker',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.stopWorker)!.description,
      inputSchema: { worker: z.string().describe('Worker id') },
    },
    async ({ worker }) => {
      try {
        return json(await runtime.stopWorker(worker));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.newChat,
    {
      title: 'Start a new chat',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.newChat)!.description,
      inputSchema: { worker: z.string().describe('Worker id') },
    },
    async ({ worker }) => {
      try {
        return json(await runtime.newChat(worker));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.invokeAction,
    {
      title: 'Invoke a page action',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.invokeAction)!.description,
      inputSchema: {
        worker: z.string().describe('Worker id'),
        action_id: z.string().describe('Action id from a snapshot, e.g. "toggle-deep-think"'),
        value: z.union([z.boolean(), z.string(), z.number()]).optional(),
      },
    },
    async ({ worker, action_id, value }) => {
      try {
        return json(await runtime.invoke(worker, action_id, value));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.installPlugin,
    {
      title: 'Install a provider plugin',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.installPlugin)!.description,
      inputSchema: {
        manifest: z
          .union([z.string(), z.record(z.any())])
          .describe(
            'Plugin manifest: {id, name, version, matchPatterns, capabilities, selectors:{input, sendButton, response, streaming, …}}',
          ),
        persist: z.boolean().optional().describe('Write plugins/<id>/plugin.json so it survives restarts'),
        replace: z.boolean().optional().describe('Replace an already installed plugin with the same id'),
      },
    },
    async ({ manifest, persist, replace }) => {
      try {
        const plugin = await runtime.installPlugin(manifest as never, { persist, replace });
        return json(plugin);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.workerContext,
    {
      title: 'Worker runtime guide',
      description: toolCatalog.find((tool) => tool.name === TOOL_NAMES.workerContext)!.description,
      inputSchema: {},
    },
    async () => {
      const status = runtime.status();
      const line = (worker: (typeof status.workers)[number]) =>
        `- \`${worker.id}\` — ${worker.pluginName} (${worker.provider}) — ${worker.status}` +
        ` — capabilities: ${worker.capabilities.join(', ') || 'none'}`;
      const text = [
        AGENT_GUIDE,
        '',
        '## Currently available',
        status.workers.length ? status.workers.map(line).join('\n') : '_No workers yet._',
        '',
        '## Installed plugins',
        status.plugins.map((plugin) => `- \`${plugin.id}\` ${plugin.name} v${plugin.version} (${plugin.source})`).join('\n'),
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  /* ------------------------------- resources ------------------------------ */

  server.registerResource(
    'workers',
    new ResourceTemplate('browsermind://workers{?provider}', { list: undefined }),
    { title: 'Browser AI workers', description: 'Live worker inventory (read-only)', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(runtime.listWorkers(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'plugins',
    new ResourceTemplate('browsermind://plugins', { list: undefined }),
    { title: 'Provider plugins', description: 'Installed provider plugins (read-only)', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(runtime.listPlugins(), null, 2) }],
    }),
  );

  return {
    server,
    async connectStdio() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async close() {
      await server.close();
    },
  };
}
