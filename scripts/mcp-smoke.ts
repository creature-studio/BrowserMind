/**
 * MCP smoke test — talks to `browsermind mcp` with the *real* MCP SDK client
 * over stdio, exactly like Claude Desktop or Cursor would.
 *
 * Run with `npm run check:mcp`. Simulated pages are used so no browser is
 * needed; the tool surface and the runtime behind it are the production ones.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    'node_modules/tsx/dist/cli.mjs',
    'packages/runtime/src/cli.ts',
    'mcp',
    '--simulate',
    'deepseek,claude',
    '--extension-port',
    '8912',
    '--log-level',
    'warn',
  ],
  cwd: process.cwd(),
  stderr: 'inherit',
});

const client = new Client({ name: 'browsermind-smoke', version: '1.0.0' });
const fail = (message: string): never => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  console.log(`tools: ${names.join(', ')}`);
  for (const required of ['browser_ai_list_workers', 'browser_ai_send_message', 'browser_ai_get_response', 'browser_ai_snapshot']) {
    if (!names.includes(required)) fail(`missing tool ${required}`);
  }

  const text = (result: unknown): string => {
    const first = (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0];
    if (!first?.text) return fail('tool returned no text content');
    return first.text;
  };

  const workers = JSON.parse(text(await client.callTool({ name: 'browser_ai_list_workers', arguments: {} }))) as Array<{ id: string }>;
  console.log(`workers: ${workers.map((worker) => worker.id).join(', ')}`);
  if (!workers.some((worker) => worker.id === 'deepseek-1')) fail('deepseek-1 was not registered');

  const context = text(await client.callTool({ name: 'browser_ai_worker_context', arguments: {} }));
  console.log(`worker_context: ${context.length} chars`);

  const sent = JSON.parse(
    text(await client.callTool({ name: 'browser_ai_send_message', arguments: { provider: 'deepseek', message: 'MCP hello' } })),
  ) as { worker: string; response?: string; durationMs?: number };
  console.log(`send_message: ${sent.worker} → ${sent.response?.slice(0, 60)}… (${sent.durationMs}ms)`);
  if (!sent.response?.includes('complete reply')) fail('the simulated provider did not answer');

  const snapshot = JSON.parse(text(await client.callTool({ name: 'browser_ai_snapshot', arguments: { worker: 'deepseek-1', transcript: false } }))) as {
    state: string;
    availableActions: Array<{ id: string }>;
  };
  console.log(`snapshot: ${snapshot.state} [${snapshot.availableActions.map((action) => action.id).join(', ')}]`);

  const installed = JSON.parse(
    text(
      await client.callTool({
        name: 'browser_ai_install_plugin',
        arguments: {
          manifest: {
            id: 'smoke-chat',
            name: 'Smoke Chat',
            version: '1.0.0',
            matchPatterns: ['https://smoke.example/*'],
            selectors: { input: ['textarea'], response: ['.answer'] },
          },
        },
      }),
    ),
  ) as { id: string };
  console.log(`install_plugin: ${installed.id}`);

  const resources = await client.listResources().catch(() => null);
  const templates = await client.listResourceTemplates().catch(() => null);
  const uris = [
    ...(resources?.resources ?? []).map((resource) => resource.uri),
    ...(templates?.resourceTemplates ?? []).map((template) => template.uriTemplate),
  ];
  console.log(`resources: ${uris.join(', ') || '(none)'}`);

  console.log('\nMCP round trip OK');
  await client.close();
  process.exit(0);
} catch (error) {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
}
