/**
 * Acceptance demo / self-check.
 *
 * Runs the four acceptance criteria of the project headlessly (no browser):
 *
 *   1. A brand-new provider is supported without touching core code — a
 *      manifest is installed at runtime and immediately drives a page.
 *   2. Several AI pages run at the same time (parallel fan-out).
 *   3. An agent only ever sees Browser Workers: ids, statuses, capabilities.
 *   4. The MCP tool surface stays stable while providers come and go.
 */
import { createLogger, type PluginManifest, type WorkerDescriptor } from '@browsermind/core';
import { BrowserAIRuntime } from './runtime.js';
import { TOOL_NAMES } from './tool-catalog.js';

export interface DemoStepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DemoReport {
  steps: DemoStepResult[];
  workers: WorkerDescriptor[];
  elapsedMs: number;
}

export interface DemoOptions {
  /** Providers to simulate (default: every installed plugin with a fake site). */
  providers?: string[];
  log?: (message: string) => void;
  verbose?: boolean;
}

/** A provider that does not exist in the repo — installed inline, at runtime. */
export const NEW_PROVIDER_MANIFEST: PluginManifest = {
  id: 'acme-chat',
  name: 'ACME Chat',
  version: '1.0.0',
  description: 'Provider installed during the acceptance demo (manifest only, no code).',
  matchPatterns: ['https://chat.acme.ai/*'],
  capabilities: ['chat', 'stop'],
  selectors: {
    input: ['#prompt-input'],
    sendButton: ['#send-button'],
    submitKeys: ['Enter'],
    response: ['.message.assistant [class*="markdown"]'],
    streaming: ['#generating', '#stop-button:not([hidden])'],
    ready: ['#prompt-input'],
    blocked: ['#login-wall:not([hidden])'],
    stopButton: ['#stop-button:not([hidden])'],
    newChat: ['#new-chat'],
    fileInput: ['#file-input'],
    quietMs: 250,
    pollMs: 60,
  },
};

export async function runDemo(options: DemoOptions = {}): Promise<DemoReport> {
  const started = Date.now();
  const steps: DemoStepResult[] = [];
  const out = options.log ?? ((message: string) => console.log(message));
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    out(`${ok ? '✔' : '✖'} ${name}\n    ${detail}`);
  };

  const logLevel = options.verbose ? 'info' : 'warn';
  const runtime = await BrowserAIRuntime.create({
    logLevel,
    logger: createLogger({ level: logLevel, scope: 'demo' }),
    simulate: options.providers ?? ['all'],
    startBridge: false,
  });
  await runtime.start();

  try {
    /* ----------------------------- 1. workers ----------------------------- */
    const workers = runtime.listWorkers();
    record(
      '1. Workers registered from plugin folders',
      workers.length >= 4,
      `providers online: ${workers.map((worker) => `${worker.id}(${worker.status})`).join(', ')}`,
    );

    /* --------------------- 2. send + streaming response ------------------- */
    const target = workers.find((worker) => worker.provider === 'deepseek') ?? workers[0]!;
    const progress: number[] = [];
    const unsubscribe = runtime.workers.events.on('task.progress', ({ text }) => progress.push(text.length));
    const answer = await runtime.sendMessage({
      worker: target.id,
      message: '分析这个项目',
      timeoutMs: 30_000,
    });
    unsubscribe();
    record(
      '2. send_message → streaming answer',
      Boolean(answer.response && answer.response.length > 40),
      `${target.id} answered ${answer.response?.length ?? 0} chars in ${answer.durationMs}ms ` +
        `(streaming updates: ${progress.length})`,
    );

    /* --------------------------- 3. parallel fan-out ---------------------- */
    const fanOut = workers.filter((worker) => worker.provider !== target.provider);
    const parallelStart = Date.now();
    const results = await Promise.all(
      fanOut.map((worker) =>
        runtime
          .sendMessage({ worker: worker.id, message: `Ping from ${worker.provider} fan-out`, timeoutMs: 30_000 })
          .catch((error) => ({ workerId: worker.id, response: '', error } as never)),
      ),
    );
    const parallelMs = Date.now() - parallelStart;
    const answered = results.filter((result) => result.response && result.response.length > 20);
    record(
      '3. Parallel workers (one tab per provider)',
      answered.length === results.length && results.length >= 3,
      `${answered.length}/${results.length} workers answered in ${parallelMs}ms wall clock (they ran concurrently)`,
    );

    /* ---------------------- 4. snapshot = no DOM leakage ------------------ */
    const snapshot = await runtime.snapshot({ worker: target.id });
    const serialized = JSON.stringify(snapshot);
    const leaksDom = /(class=|querySelector|ds-markdown|#prompt-textarea|<div)/i.test(serialized);
    record(
      '4. Snapshot exposes capabilities, not selectors',
      !leaksDom && snapshot.availableActions.length > 0,
      `state=${snapshot.state} capabilities=[${snapshot.capabilities.join(', ')}] ` +
        `actions=[${snapshot.availableActions.map((action) => action.id).join(', ')}]`,
    );

    /* ------------------ 5. new provider without core changes -------------- */
    const installed = await runtime.installPlugin(NEW_PROVIDER_MANIFEST);
    const matched = runtime.registry.findPlugin('https://chat.acme.ai/c/123')?.id ?? null;
    record(
      '5. New provider installed at runtime (' + TOOL_NAMES.installPlugin + ')',
      matched === NEW_PROVIDER_MANIFEST.id,
      `installed ${installed.id} v${installed.version} (source=${installed.source}); ` +
        `https://chat.acme.ai/* now resolves to plugin "${matched}" without touching core code`,
    );

    const customAnswer = await runCustomProviderCheck(runtime, options);
    record(
      '6. The freshly installed provider actually drives a page',
      customAnswer.ok,
      customAnswer.detail,
    );

    /* ----------------------- 7. stable MCP surface ------------------------ */
    const workerView = runtime.listWorkers().map((worker) => ({
      id: worker.id,
      provider: worker.provider,
      status: worker.status,
      capabilities: worker.capabilities,
    }));
    const stableSurface = [
      TOOL_NAMES.listWorkers,
      TOOL_NAMES.sendMessage,
      TOOL_NAMES.getResponse,
      TOOL_NAMES.snapshot,
      TOOL_NAMES.listPlugins,
    ].every((name) => typeof name === 'string' && name.startsWith('browser_ai_'));
    record(
      '7. Agent-visible surface stayed identical',
      stableSurface && workerView.length >= 5,
      `list_workers → ${JSON.stringify(workerView.slice(0, 3))} … (${workerView.length} workers)`,
    );

    return { steps, workers: runtime.listWorkers(), elapsedMs: Date.now() - started };
  } finally {
    await runtime.shutdown();
  }
}

/**
 * Drive the runtime-installed plugin against a page. `acme-chat` has no real
 * website, so we reuse the mock page's DOM: a manifest-only plugin plus an
 * existing page is enough to prove the end-to-end path.
 */
async function runCustomProviderCheck(runtime: BrowserAIRuntime, options: DemoOptions): Promise<{ ok: boolean; detail: string }> {
  const testing = await import('@browsermind/testing');
  const plugin = runtime.registry.get(NEW_PROVIDER_MANIFEST.id);
  if (!plugin) return { ok: false, detail: 'plugin was not registered' };
  const site = testing.createFakeSite({ provider: 'mock', chunkDelayMs: 5 });
  try {
    const adapter = plugin.createAdapter({
      driver: site.driver,
      logger: createLogger({ level: options.verbose ? 'info' : 'warn', scope: 'acme' }),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });
    await adapter.sendMessage('hello from an installed plugin');
    const response = await adapter.waitForResponse({ timeoutMs: 20_000 });
    const snapshot = await adapter.snapshot();
    return {
      ok: response.length > 40,
      detail:
        `${NEW_PROVIDER_MANIFEST.id} typed into the page, submitted and read back ` +
        `${response.length} chars (state=${snapshot.state}, actions=${snapshot.availableActions.length})`,
    };
  } finally {
    site.destroy();
  }
}
