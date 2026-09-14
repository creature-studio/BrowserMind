#!/usr/bin/env node
/**
 * BrowserMind CLI.
 *
 *   browsermind mcp            MCP server over stdio (Claude Desktop, Cursor, …)
 *   browsermind serve          extension bridge + HTTP API + live dashboard
 *   browsermind demo           headless acceptance run (no browser needed)
 *   browsermind doctor         diagnose plugins, bridge and extension
 *   browsermind plugins        list installed provider plugins
 *   browsermind install <f>    install a declarative plugin (manifest JSON)
 */
import { readFile } from 'node:fs/promises';
import { PluginRegistry, createLogger, defaultPluginDir, loadPluginsFromDisk } from '@browsermind/core';
import { BrowserAIRuntime } from './runtime.js';
import { createMcpServer } from './mcp/server.js';
import { startHttpServer } from './http.js';
import { runDemo } from './demo.js';
import { TOOL_NAMES } from './tool-catalog.js';

interface Flags {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const FLAG_ALIASES: Record<string, string> = {
  '-p': 'plugins',
  '--plugins': 'plugins',
  '--plugin-dir': 'plugins',
  '--port': 'extension-port',
  '--http-port': 'http-port',
  '--simulate': 'simulate',
  '--log-level': 'log-level',
  '--timeout': 'timeout',
  '-v': 'verbose',
  '--verbose': 'verbose',
  '-h': 'help',
  '--help': 'help',
  '--persist': 'persist',
  '--providers': 'providers',
};

function parseArgs(argv: string[]): Flags {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token.startsWith('-')) {
      const key = FLAG_ALIASES[token] ?? token.replace(/^--?/, '');
      const next = rest[index + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flags.flags[key];
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function listFlag(flags: Flags, key: string): string[] | undefined {
  const value = flags.flags[key];
  if (typeof value !== 'string') return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pluginDir(flags: Flags): string {
  return typeof flags.flags.plugins === 'string' ? flags.flags.plugins : defaultPluginDir();
}

const HELP = `BrowserMind — Browser AI Worker Runtime

Usage
  browsermind <command> [options]

Commands
  mcp                     Run the MCP server on stdio (for any MCP client)
  serve                   Run the extension bridge + HTTP API + dashboard
  demo                    Headless acceptance run against the simulator
  doctor                  Diagnose plugins, bridge port and extension link
  plugins                 List installed provider plugins
  install <manifest.json> Install a declarative provider plugin (--persist to save it)

Options
  --plugins <dir>         Plugin folder (default: ./plugins)
  --port <n>              Extension bridge port (default 8765)
  --http-port <n>         Dashboard/API port (default 8787)
  --simulate <a,b|all>    Run providers headlessly (no browser needed)
  --providers <a,b|all>   Providers used by "demo"
  --timeout <ms>          Task timeout (default 180000)
  --log-level <level>     debug | info | warn | error | silent
  --persist               install: write plugins/<id>/plugin.json

Examples
  browsermind serve --simulate all
  browsermind mcp --simulate deepseek
  browsermind demo --providers all
  browsermind install ./my-provider.json --persist

MCP tools exposed: ${Object.values(TOOL_NAMES).join(', ')}
`;

function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[browsermind] ${line}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.command === 'help' || args.command === '--help') {
    console.log(HELP);
    return 0;
  }

  const logLevel = (typeof args.flags['log-level'] === 'string' ? args.flags['log-level'] : 'info') as
    | 'debug'
    | 'info'
    | 'warn'
    | 'error'
    | 'silent';
  const logger = createLogger({ level: logLevel, scope: 'cli' });
  const dir = pluginDir(args);
  const simulate = listFlag(args, 'simulate');
  const timeoutMs = numberFlag(args, 'timeout', 180_000);

  switch (args.command) {
    case 'mcp': {
      const runtime = await BrowserAIRuntime.create({
        pluginDir: dir,
        logger,
        logLevel,
        simulate,
        extensionPort: numberFlag(args, 'extension-port', 8765),
        taskTimeoutMs: timeoutMs,
      });
      const started = await runtime.start();
      logger.info('runtime ready', { extensionPort: started.extensionPort, workers: started.workers.length });
      const mcp = createMcpServer({ runtime });
      await mcp.connectStdio();
      const shutdown = async () => {
        await mcp.close().catch(() => undefined);
        await runtime.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // An MCP client that goes away closes stdin: stop instead of lingering.
      process.stdin.on('end', () => void shutdown());
      process.stdin.on('close', () => void shutdown());
      return await new Promise<number>(() => undefined);
    }

    case 'serve': {
      const runtime = await BrowserAIRuntime.create({
        pluginDir: dir,
        logger,
        logLevel,
        simulate,
        extensionPort: numberFlag(args, 'extension-port', 8765),
        taskTimeoutMs: timeoutMs,
        statusPollMs: 5_000,
      });
      const started = await runtime.start();
      const http = await startHttpServer({
        runtime,
        port: numberFlag(args, 'http-port', 8787),
        logger: (message, meta) => logger.debug(message, meta),
      });
      const status = runtime.status();
      log('info', `dashboard        ${http.url}`);
      log('info', `extension bridge ws://0.0.0.0:${started.extensionPort}/browsermind/extension`);
      log('info', `plugins          ${status.plugins.length} (${status.plugins.map((plugin) => plugin.id).join(', ')})`);
      log('info', `workers          ${status.workers.length}${simulate ? ` (simulated: ${simulate.join(', ')})` : ''}`);
      log('info', 'waiting for the extension to connect… (load packages/extension in chrome://extensions)');
      const shutdown = async () => {
        log('info', 'shutting down');
        await http.close();
        await runtime.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return await new Promise<number>(() => undefined);
    }

    case 'demo': {
      const providers = listFlag(args, 'providers') ?? simulate ?? ['all'];
      const report = await runDemo({ providers, verbose: Boolean(args.flags.verbose) });
      const failed = report.steps.filter((step) => !step.ok);
      console.log('');
      console.log(`Acceptance: ${report.steps.length - failed.length}/${report.steps.length} checks passed in ${report.elapsedMs}ms`);
      console.log('Workers seen by the agent:');
      for (const worker of report.workers) {
        console.log(`  - ${worker.id}  ${worker.provider}  ${worker.status}  [${worker.capabilities.join(', ')}]`);
      }
      return failed.length === 0 ? 0 : 1;
    }

    case 'doctor': {
      const registry = new PluginRegistry();
      const { loaded, failed } = await loadPluginsFromDisk({ dir, registry, logger });
      console.log(`Plugin folder      ${dir}`);
      console.log(`Plugins loaded     ${loaded.length}`);
      for (const entry of loaded) {
        console.log(`  - ${entry.descriptor.id} v${entry.descriptor.version} (${entry.descriptor.source}) ${entry.descriptor.matchPatterns.join(' ')}`);
      }
      if (failed.length) {
        console.log(`Plugins failed     ${failed.length}`);
        for (const failure of failed) console.log(`  ✖ ${failure.dir}: ${failure.error}`);
      }
      const port = numberFlag(args, 'extension-port', 8765);
      const runtime = await BrowserAIRuntime.create({ pluginDir: dir, logger, logLevel: 'warn', startBridge: true, extensionPort: port });
      let connected = false;
      try {
        const started = await runtime.start();
        console.log(`Bridge port        ${started.extensionPort}`);
        connected = await runtime.waitForExtension(2_000);
      } catch (error) {
        const code = (error as { code?: string }).code;
        console.log(`Bridge port        ${port} — ${code === 'EADDRINUSE' ? 'already in use (another runtime is running)' : String(error)}`);
      }
      console.log(`Extension          ${connected ? 'connected' : 'not connected (load packages/extension in Chrome)'}`);
      console.log(`Worker API         ${TOOL_NAMES.sendMessage} / ${TOOL_NAMES.getResponse} / ${TOOL_NAMES.listWorkers}`);
      await runtime.shutdown();
      return failed.length === 0 ? 0 : 1;
    }

    case 'plugins': {
      const registry = new PluginRegistry();
      const { loaded } = await loadPluginsFromDisk({ dir, registry, logger });
      for (const entry of loaded) {
        const descriptor = entry.descriptor;
        console.log(`${descriptor.id.padEnd(12)} ${descriptor.name} v${descriptor.version}  [${descriptor.source}]`);
        console.log(`  patterns:     ${descriptor.matchPatterns.join(', ')}`);
        console.log(`  capabilities: ${descriptor.capabilities.join(', ')}`);
        if (descriptor.description) console.log(`  about:        ${descriptor.description}`);
      }
      return 0;
    }

    case 'install': {
      const file = args.positional[0];
      if (!file) {
        log('error', 'usage: browsermind install <manifest.json> [--persist]');
        return 2;
      }
      const raw = await readFile(file, 'utf8');
      const runtime = await BrowserAIRuntime.create({ pluginDir: dir, logger, logLevel: 'warn', startBridge: false });
      const descriptor = await runtime.installPlugin(raw, { persist: Boolean(args.flags.persist), replace: true });
      log('info', `installed ${descriptor.id} v${descriptor.version} (${descriptor.matchPatterns.join(', ')})`);
      if (args.flags.persist) log('info', `persisted to ${runtime.pluginDir}/${descriptor.id}/plugin.json`);
      await runtime.shutdown();
      return 0;
    }

    default:
      console.log(HELP);
      return args.command === 'help' ? 0 : 2;
  }
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((error) => {
    console.error('[browsermind] fatal:', error);
    process.exitCode = 1;
  });
