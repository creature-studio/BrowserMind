/**
 * The stable `browser_ai.*` surface.
 *
 * This file is the contract the outside world depends on: MCP tools, the HTTP
 * API and the docs are all generated from it. Provider plugins come and go;
 * these names do not change.
 */
export const BRAND = 'browser_ai';

export const TOOL_NAMES = {
  listWorkers: 'browser_ai_list_workers',
  sendMessage: 'browser_ai_send_message',
  getResponse: 'browser_ai_get_response',
  snapshot: 'browser_ai_snapshot',
  listPlugins: 'browser_ai_list_plugins',
  openWorker: 'browser_ai_open_worker',
  closeWorker: 'browser_ai_close_worker',
  stopWorker: 'browser_ai_stop_worker',
  newChat: 'browser_ai_new_chat',
  invokeAction: 'browser_ai_invoke_action',
  installPlugin: 'browser_ai_install_plugin',
  workerContext: 'browser_ai_worker_context',
  health: 'browser_ai_health',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export interface ToolDoc {
  name: ToolName;
  title: string;
  description: string;
  /** REST path exposed by `browsermind serve` (POST unless noted). */
  http: string;
}

export const toolCatalog: ToolDoc[] = [
  {
    name: TOOL_NAMES.health,
    title: 'Runtime health',
    description: 'Report runtime, extension-bridge and provider-plugin state. Use it first when something looks wrong.',
    http: '/api/health',
  },
  {
    name: TOOL_NAMES.listWorkers,
    title: 'List browser AI workers',
    description:
      'List every worker (one per browser tab / simulated page) with id, provider, status and capabilities.',
    http: '/api/workers',
  },
  {
    name: TOOL_NAMES.sendMessage,
    title: 'Send a message to a worker',
    description:
      'Send a prompt to a worker and (by default) wait for the answer. Address the worker by id (`deepseek-1`) or by provider (`deepseek`).',
    http: '/api/send_message',
  },
  {
    name: TOOL_NAMES.getResponse,
    title: 'Read a worker response',
    description: 'Fetch the answer of the last task, or wait for the task that is currently running.',
    http: '/api/get_response',
  },
  {
    name: TOOL_NAMES.snapshot,
    title: 'Snapshot a worker page',
    description:
      'Return the provider-agnostic view of a page: state, capabilities, available actions and transcript. No DOM, no selectors.',
    http: '/api/snapshot',
  },
  {
    name: TOOL_NAMES.listPlugins,
    title: 'List provider plugins',
    description: 'Show which provider plugins are installed, their match patterns, capabilities and source.',
    http: '/api/plugins',
  },
  {
    name: TOOL_NAMES.openWorker,
    title: 'Open a worker',
    description: 'Open (or reuse) a browser tab for a provider and register it as a worker.',
    http: '/api/open_worker',
  },
  {
    name: TOOL_NAMES.closeWorker,
    title: 'Close a worker',
    description: 'Close the tab belonging to a worker and unregister it.',
    http: '/api/close_worker',
  },
  {
    name: TOOL_NAMES.stopWorker,
    title: 'Stop a worker',
    description: 'Abort the answer a worker is currently generating and cancel the running task.',
    http: '/api/stop_worker',
  },
  {
    name: TOOL_NAMES.newChat,
    title: 'Start a new chat',
    description: 'Reset the conversation on a worker page (new chat / new thread).',
    http: '/api/new_chat',
  },
  {
    name: TOOL_NAMES.invokeAction,
    title: 'Invoke a page action',
    description: 'Execute one of the actions advertised in a snapshot (toggles such as DeepThink, DeepSearch, tools…).',
    http: '/api/invoke_action',
  },
  {
    name: TOOL_NAMES.installPlugin,
    title: 'Install a provider plugin',
    description:
      'Install a declarative plugin at runtime: manifest + selector pack, no code, no restart. Optionally persist it into the plugin folder.',
    http: '/api/install_plugin',
  },
  {
    name: TOOL_NAMES.workerContext,
    title: 'Worker runtime guide',
    description: 'Operating instructions for this runtime plus the live worker/plugin inventory. Read once per session.',
    http: '/api/context',
  },
];

/** Short guide returned by `browser_ai_worker_context`. */
export const AGENT_GUIDE = `# BrowserMind — Browser AI Worker Runtime

You are talking to a runtime that turns *web chat pages* (DeepSeek, ChatGPT,
Claude, Gemini, Grok, …) into uniform **workers**.

Rules of engagement:

1. Never assume which website is behind a worker. Use \`provider\` to pick one,
   never selectors, DOM or page structure — those live inside plugins.
2. \`${TOOL_NAMES.listWorkers}\` first. A worker that is \`ready\` can accept work
   immediately; \`busy\` means it is generating; \`blocked\` means the page needs a
   human (login / quota / captcha).
3. \`${TOOL_NAMES.sendMessage}\` with \`{"worker": "deepseek-1", "message": "…"}\`
   submits and (by default) waits for the full answer. Pass \`wait: false\` plus
   \`${TOOL_NAMES.getResponse}\` to run long tasks asynchronously.
4. Several workers run **in parallel**. Fan out across providers to compare
   answers, and keep one worker per conversation to preserve context.
5. \`${TOOL_NAMES.snapshot}\` tells you what a page can currently do
   (\`capabilities\`, \`availableActions\`). Use \`${TOOL_NAMES.invokeAction}\` for
   toggles like DeepThink / DeepSearch.
6. Adding a new provider never requires core changes: drop a folder into
   \`plugins/<id>/\` (manifest + selectors) or call \`${TOOL_NAMES.installPlugin}\`.

Capability vocabulary: chat, file_upload, image_input, search, tools,
stop, new_chat, deep_think, artifacts.`;
