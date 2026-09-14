import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { PLUGIN_MATCH_PATTERNS } from './src/generated/plugin-manifests';

/**
 * WXT configuration.
 *
 * Host permissions are generated from the plugin folders, so installing a new
 * provider plugin automatically widens what the extension may touch — the
 * runtime never needs to know.
 */
// Anchored to the config file so `wxt build` works from any working directory.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  srcDir: 'src',
  outDir: '.output',
  zip: {
    // Stable artifact name for CI (the extension has no package.json, so the
    // default template would emit "…-undefined-chrome.zip").
    artifactTemplate: '{{name}}-{{browser}}.zip',
  },
  targetBrowsers: ['chrome'],
  manifest: {
    name: 'BrowserMind — Browser AI Worker',
    description:
      'Turns web chat pages (DeepSeek, ChatGPT, Claude, Gemini, Grok…) into uniform Browser AI Workers for MCP agents.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['tabs', 'storage', 'scripting', 'alarms', 'activeTab'],
    host_permissions: [...PLUGIN_MATCH_PATTERNS],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: 'BrowserMind workers',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    web_accessible_resources: [
      {
        resources: ['sandbox.html'],
        matches: ['https://*/*', 'http://*/*'],
      },
    ],
  },
});
