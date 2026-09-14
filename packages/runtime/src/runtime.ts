/**
 * Browser AI runtime.
 *
 * Composition root: plugin registry + worker manager + session providers
 * (Chrome extension and/or simulator) + the `browser_ai.*` facade that MCP,
 * HTTP and the CLI all speak to.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PluginRegistry,
  RUNTIME_METHODS,
  WorkerManager,
  createDeclarativePlugin,
  createLogger,
  defaultPluginDir,
  loadPluginsFromDisk,
  silentLogger,
  toErrorPayload,
  validateManifest,
  type BrowserAIPlugin,
  type FileUpload,
  type Logger,
  type PageSnapshot,
  type PluginDescriptor,
  type PluginManifest,
  type PluginRegistry as PluginRegistryType,
  type ResponseResult,
  type SendMessageResult,
  type SessionProvider,
  type WorkerDescriptor,
} from '@browsermind/core';
import { ExtensionBridge, type ExtensionClient } from './extension-bridge.js';
import { createSimulatorProvider } from './simulator.js';

export interface BrowserAIRuntimeOptions {
  /** Folder scanned for plugin folders (`plugins/` by default). */
  pluginDir?: string;
  /** Plugins registered programmatically (tests, embedding). */
  plugins?: BrowserAIPlugin[];
  logger?: Logger;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Provider ids to run headlessly (`['all']` for every plugin with a fake site). */
  simulate?: string[];
  /** Port the extension connects to. */
  extensionPort?: number;
  extensionHost?: string;
  statusPollMs?: number;
  taskTimeoutMs?: number;
  /** Skip the extension WebSocket server entirely (CLI/testing with the simulator). */
  startBridge?: boolean;
}

export interface SendMessageRequest {
  worker?: string;
  provider?: string;
  message: string;
  /** Wait for the answer instead of returning `accepted` immediately. */
  wait?: boolean;
  timeoutMs?: number;
  files?: FileUpload[];
  newChat?: boolean;
}

export interface GetResponseRequest {
  worker?: string;
  provider?: string;
  taskId?: string;
  wait?: boolean;
  timeoutMs?: number;
}

export class BrowserAIRuntime {
  readonly registry: PluginRegistry;
  readonly workers: WorkerManager;
  readonly logger: Logger;
  readonly bridge: ExtensionBridge | null;
  #options: BrowserAIRuntimeOptions;
  #simulator: { provider: SessionProvider; destroy(): Promise<void> } | null = null;
  #started = false;
  #pluginDir: string;
  #loadedFromDisk: string[] = [];
  #clientSubscriptions = new Map<string, Array<() => void>>();

  private constructor(options: BrowserAIRuntimeOptions, registry: PluginRegistry, bridge: ExtensionBridge | null, logger: Logger) {
    this.#options = options;
    this.registry = registry;
    this.bridge = bridge;
    this.logger = logger;
    this.#pluginDir = options.pluginDir ?? defaultPluginDir();
    this.workers = new WorkerManager({
      registry,
      logger,
      defaultTimeoutMs: options.taskTimeoutMs ?? 180_000,
      statusPollMs: options.statusPollMs ?? 0,
    });
  }

  static async create(options: BrowserAIRuntimeOptions = {}): Promise<BrowserAIRuntime> {
    const logger = options.logger ?? createLogger({ level: options.logLevel ?? 'info', scope: 'runtime' });
    const registry = new PluginRegistry();
    for (const plugin of options.plugins ?? []) registry.register(plugin);

    const pluginDir = options.pluginDir ?? defaultPluginDir();
    const loaded = await loadPluginsFromDisk({ dir: pluginDir, registry, logger: logger.child('plugins') });
    for (const failure of loaded.failed) {
      logger.warn('plugin failed to load', { dir: failure.dir, error: failure.error });
    }

    // The bridge callbacks need the runtime instance which is created below;
    // they only ever run once a browser connects, so late binding is safe.
    let runtime!: BrowserAIRuntime;
    let bridge: ExtensionBridge | null = null;
    if (options.startBridge ?? true) {
      bridge = new ExtensionBridge({
        port: options.extensionPort ?? 8765,
        host: options.extensionHost,
        logger: logger.child('bridge'),
        onClient: async (client: ExtensionClient) => runtime.attachExtension(client),
        onClose: (client: ExtensionClient) => runtime.detachExtension(client),
      });
    }

    runtime = new BrowserAIRuntime(options, registry, bridge, logger);
    runtime.#loadedFromDisk = loaded.loaded.map((entry) => entry.descriptor.id);

    if (options.simulate?.length) {
      runtime.#simulator = await createSimulatorProvider({
        registry,
        providers: options.simulate,
        logger: logger.child('simulator'),
      });
      await runtime.workers.addProvider(runtime.#simulator.provider);
    }
    return runtime;
  }

  /**
   * A browser connected: expose the runtime to it (state + live updates) and
   * register its pages as a session provider.
   */
  async attachExtension(client: ExtensionClient): Promise<void> {
    client.peer.handle(RUNTIME_METHODS.state, () => this.status());
    const push = () => {
      if (client.peer.closed) return;
      client.peer.notify(RUNTIME_METHODS.workers, { workers: this.listWorkers() });
      client.peer.notify(RUNTIME_METHODS.plugins, { plugins: this.listPlugins(), manifests: this.declarativeManifests() });
    };
    const unsubscribe = [
      this.workers.events.on('worker.added', push),
      this.workers.events.on('worker.updated', push),
      this.workers.events.on('worker.removed', push),
      this.workers.events.on('task.started', push),
      this.workers.events.on('task.completed', push),
      this.workers.events.on('task.failed', push),
    ];
    this.#clientSubscriptions.set(client.id, unsubscribe);
    await this.workers.addProvider(client.provider);
    push();
    this.logger.info('extension attached', { id: client.id });
  }

  async detachExtension(client: ExtensionClient): Promise<void> {
    for (const unsubscribe of this.#clientSubscriptions.get(client.id) ?? []) unsubscribe();
    this.#clientSubscriptions.delete(client.id);
    await this.workers.removeProvider(client.provider);
    this.logger.info('extension detached', { id: client.id });
  }

  /** Manifests of declarative plugins — forwarded so the extension can mirror them. */
  declarativeManifests(): PluginManifest[] {
    return this.registry
      .entries()
      .map((entry) => entry.plugin.manifest)
      .filter((manifest): manifest is PluginManifest => Boolean(manifest));
  }

  /** Notify every connected extension that the plugin catalog changed. */
  #broadcastPlugins(): void {
    for (const client of this.bridge?.clients ?? []) {
      if (client.peer.closed) continue;
      client.peer.notify(RUNTIME_METHODS.plugins, {
        plugins: this.listPlugins(),
        manifests: this.declarativeManifests(),
      });
    }
  }

  async start(): Promise<{ extensionPort: number | null; workers: WorkerDescriptor[] }> {
    if (this.#started) return { extensionPort: this.bridge?.listeningPort() ?? null, workers: this.workers.listWorkers() };
    this.#started = true;
    let port: number | null = null;
    if (this.bridge) port = await this.bridge.start();
    await this.workers.start();
    return { extensionPort: port, workers: this.workers.listWorkers() };
  }

  async shutdown(): Promise<void> {
    await this.workers.stop();
    await this.bridge?.stop();
    await this.#simulator?.destroy();
    this.#simulator = null;
    this.#started = false;
  }

  /* ------------------------------------------------------------------ */
  /* Catalog                                                             */
  /* ------------------------------------------------------------------ */

  listPlugins(): PluginDescriptor[] {
    return this.registry.list();
  }

  listWorkers(): WorkerDescriptor[] {
    return this.workers.listWorkers();
  }

  /** Human readable runtime status for the CLI and the dashboard. */
  status(): {
    extension: { connected: number; port: number | null; clients: Array<{ id: string; connectedAt: number }> };
    workers: WorkerDescriptor[];
    plugins: PluginDescriptor[];
    simulated: string[];
  } {
    return {
      extension: {
        connected: this.bridge?.clients.length ?? 0,
        port: this.bridge?.listeningPort() ?? null,
        clients: (this.bridge?.clients ?? []).map((client) => ({ id: client.id, connectedAt: client.connectedAt })),
      },
      workers: this.listWorkers(),
      plugins: this.listPlugins(),
      simulated: this.#options.simulate ?? [],
    };
  }

  /** Wait for the extension to connect — the CLI uses this to give good errors. */
  async waitForExtension(timeoutMs = 20_000): Promise<boolean> {
    if (!this.bridge) return false;
    if (this.bridge.clients.length > 0) return true;
    const client = await this.bridge.waitForClient(timeoutMs);
    return Boolean(client);
  }

  /* ------------------------------------------------------------------ */
  /* Worker operations                                                   */
  /* ------------------------------------------------------------------ */

  #resolveWorkerRef(request: { worker?: string; provider?: string }): string | null {
    if (request.worker) return request.worker;
    if (!request.provider) return this.listWorkers()[0]?.id ?? null;
    const matching = this.listWorkers().filter((worker) => worker.provider === request.provider);
    return matching[matching.length - 1]?.id ?? null;
  }

  async openWorker(request: { provider?: string; url?: string; reuse?: boolean }): Promise<WorkerDescriptor> {
    return this.workers.openWorker(request);
  }

  async closeWorker(worker: string): Promise<{ id: string; closed: boolean }> {
    return this.workers.closeWorker(worker);
  }

  async stopWorker(worker: string): Promise<{ id: string; stopped: boolean; cancelledTask?: string }> {
    return this.workers.stopWorker(worker);
  }

  async newChat(worker: string): Promise<{ id: string; ok: boolean }> {
    return this.workers.newChat(worker);
  }

  async invoke(worker: string, actionId: string, value?: unknown): Promise<unknown> {
    return this.workers.invoke(worker, actionId, value);
  }

  async focus(worker: string): Promise<{ id: string; focused: boolean }> {
    return this.workers.focus(worker);
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const workerRef = await this.#ensureWorker(request);
    return this.workers.sendMessage(workerRef, request.message, {
      waitForResponse: request.wait ?? true,
      timeoutMs: request.timeoutMs,
      files: request.files,
      options: request.newChat ? { newChat: true } : undefined,
    });
  }

  async getResponse(request: GetResponseRequest): Promise<ResponseResult> {
    const workerRef = this.#resolveWorkerRef(request) ?? (await this.#ensureWorker(request as SendMessageRequest));
    return this.workers.getResponse(workerRef, {
      taskId: request.taskId,
      wait: request.wait,
      timeoutMs: request.timeoutMs,
    });
  }

  async snapshot(request: { worker?: string; provider?: string; transcript?: boolean }): Promise<PageSnapshot> {
    const workerRef = this.#resolveWorkerRef(request);
    if (!workerRef) {
      throw new Error('No worker available. Open a provider tab with the extension, or start the runtime with --simulate.');
    }
    return this.workers.snapshot(workerRef, { transcript: request.transcript });
  }

  /** Resolve (and if necessary open) the worker a request should run on. */
  async #ensureWorker(request: { worker?: string; provider?: string }): Promise<string> {
    const existing = this.#resolveWorkerRef(request);
    if (existing) return existing;
    if (request.provider) {
      const opened = await this.workers.openWorker({ provider: request.provider, reuse: true });
      return opened.id;
    }
    throw new Error(
      'No worker available. Open a provider tab with the extension, or start the runtime with --simulate.',
    );
  }

  /* ------------------------------------------------------------------ */
  /* Plugin installation (Phase 4)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Install a declarative plugin at runtime: a selector pack plus metadata is
   * all a new provider needs. Pass `persist: true` to keep it for the next
   * start (writes `plugins/<id>/plugin.json`).
   */
  async installPlugin(
    manifestOrJson: PluginManifest | string,
    options: { persist?: boolean; replace?: boolean } = {},
  ): Promise<PluginDescriptor> {
    const manifest =
      typeof manifestOrJson === 'string'
        ? validateManifest((JSON.parse(manifestOrJson) as { plugin?: PluginManifest }).plugin ?? JSON.parse(manifestOrJson))
        : validateManifest(manifestOrJson);
    if (this.registry.has(manifest.id) && !options.replace) {
      throw new Error(`Plugin "${manifest.id}" is already installed (pass replace=true to override)`);
    }
    const plugin = createDeclarativePlugin(manifest);
    this.registry.register(plugin, { source: 'declarative', installedAt: Date.now(), enabled: true });
    if (options.persist) {
      const dir = path.join(this.#pluginDir, manifest.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      this.logger.info('plugin persisted', { id: manifest.id, dir });
    }
    this.logger.info('plugin installed', { id: manifest.id, patterns: manifest.matchPatterns });
    this.#broadcastPlugins();
    return plugin.describe();
  }

  async uninstallPlugin(id: string, options: { deleteFiles?: boolean } = {}): Promise<{ id: string; removed: boolean }> {
    const entry = this.registry.getEntry(id);
    const removed = this.registry.unregister(id);
    if (options.deleteFiles && entry?.source !== 'builtin') {
      await rm(path.join(this.#pluginDir, id), { recursive: true, force: true });
    }
    if (removed) this.#broadcastPlugins();
    return { id, removed };
  }

  get pluginDir(): string {
    return this.#pluginDir;
  }

  get loadedFromDisk(): string[] {
    return [...this.#loadedFromDisk];
  }

  /** Wrap an error the way the MCP layer reports it. */
  static errorPayload(error: unknown) {
    return toErrorPayload(error);
  }
}

export { silentLogger };
