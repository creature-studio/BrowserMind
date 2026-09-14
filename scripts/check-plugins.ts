/**
 * Plugin smoke test — every shipped plugin is driven against its own fake page.
 *
 * Run with `npm run check:plugins`. This is deliberately *outside* vitest so it
 * can be pointed at a different plugin folder (`--dir ./my-plugins`) and shows
 * a human-readable capability matrix.
 */
import { loadPluginsFromDisk } from '../packages/core/src/index.js';
import { createFakeSite } from '../packages/testing/src/index.js';
import { silentLogger } from '../packages/core/src/logger.js';

const dirFlag = process.argv.indexOf('--dir');
const pluginDir = dirFlag > -1 ? process.argv[dirFlag + 1] : undefined;

const { registry, loaded, failed } = await loadPluginsFromDisk({ dir: pluginDir, logger: silentLogger });
console.log(`plugins: ${loaded.map((entry) => `${entry.descriptor.id}@${entry.descriptor.version} (${entry.descriptor.source})`).join(', ')}`);
if (failed.length) {
  for (const failure of failed) console.error(`FAIL ${failure.dir}: ${failure.error}`);
  process.exit(1);
}

let failures = 0;
for (const { descriptor } of loaded) {
  const plugin = registry.get(descriptor.id);
  if (!plugin) continue;
  try {
    const site = createFakeSite({ provider: descriptor.id, chunkDelayMs: 5 });
    const adapter = plugin.createAdapter({
      driver: site.driver,
      logger: silentLogger,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const status = await adapter.getStatus();
    await adapter.sendMessage('Analyse this project');
    const response = await adapter.waitForResponse({ timeoutMs: 20_000 });
    const snapshot = await adapter.snapshot();
    const capabilities = await adapter.capabilities();
    const ok = status === 'ready' && response.includes('complete reply');
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${descriptor.id}: status=${status} chars=${response.length} url=${snapshot.url} ` +
        `caps=${capabilities.join('/')} actions=${snapshot.availableActions.map((action) => action.id).join(',')}`,
    );
    if (!ok) failures += 1;
    site.destroy();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${descriptor.id}: ${(error as Error).message}`);
  }
}

console.log(failures === 0 ? `\n${loaded.length}/${loaded.length} providers OK` : `\n${failures} provider(s) failing`);
process.exit(failures === 0 ? 0 : 1);
