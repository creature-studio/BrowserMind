# BrowserMind

**Your browser is a fleet of AI workers — and every agent can drive it over MCP.**

BrowserMind turns web chat UIs (ChatGPT, Claude, DeepSeek, Gemini, Grok, …) into uniform
**Browser AI Workers**. An agent (Claude Desktop, Cursor, your own code) connects to a
runtime over **MCP** and only ever sees workers, statuses and snapshots — never a DOM node,
never a CSS selector, never a "if provider is DeepSeek then …" branch.

Everything provider-specific lives in a **plugin folder**. Adding a provider means adding a
directory: `plugins/gemini/` is already shipped and contains literally one `plugin.json`.

```
┌──────────────┐   MCP (stdio / HTTP)   ┌──────────────────────┐   WebSocket   ┌──────────────────────────┐
│  AI agent    │ ─────────────────────▶ │  BrowserMind runtime │ ────────────▶ │  Chrome extension (MV3)  │
│ Claude/Cursor│ ◀───────────────────── │  workers + plugins   │ ◀──────────── │  background ⇄ content    │
└──────────────┘   workers/statuses     └──────────────────────┘   dom + tasks  └──────────────────────────┘
                                                  │
                                       ┌──────────┴───────────┐
                                       │ simulator (jsdom)    │  same plugins, no browser — CI + demo
                                       └──────────────────────┘
```

---

## 1. What the agent sees

Thirteen MCP tools, all provider-agnostic (`packages/runtime/src/tool-catalog.ts` defines them
once and the MCP server, the HTTP API and the docs are all generated from that catalog):

| Tool | What it does |
| --- | --- |
| `browser_ai_health` | runtime + extension + plugin status |
| `browser_ai_list_workers` | every page wrapped as a worker: `deepseek-1`, `chatgpt-2`, … |
| `browser_ai_send_message` | send a prompt to a worker (waits, or returns `accepted` + `taskId`) |
| `browser_ai_get_response` | fetch the answer of a task, streamed-so-far or final |
| `browser_ai_snapshot` | URL, status, capabilities, available page actions, transcript |
| `browser_ai_list_plugins` | installed providers and their capabilities |
| `browser_ai_open_worker` / `close_worker` / `stop_worker` | tab lifecycle + cancel generation |
| `browser_ai_new_chat` | start a fresh conversation in a worker |
| `browser_ai_invoke_action` | plugin-declared page actions (`toggle-deep-think`, `attach-file`, …) |
| `browser_ai_install_plugin` | install a new provider at runtime, no restart |
| `browser_ai_worker_context` | one-shot briefing: workers, capabilities, usage guide |

Resources: `browsermind://workers` and `browsermind://plugins`.
The same surface is available over HTTP (`/api/*`, plus SSE `/api/events`) and as a dashboard,
so non-MCP agents can use it too.

```jsonc
// agent → runtime → page, and back
{ "worker": "deepseek-1", "message": "Summarise my last email thread" }
// → { "worker": "deepseek-1", "taskId": "task-4", "response": "…", "durationMs": 1037 }
```

## 2. Architecture

| Layer | Path | Responsibility |
| --- | --- | --- |
| **Core** | `packages/core` | contracts (`BrowserAIPlugin`, `AIAdapter`), `PluginRegistry`, `WorkerManager`, DOM-driver abstraction, RPC, session protocol, plugin loader. No provider names anywhere. |
| **Runtime** | `packages/runtime` | `BrowserAIRuntime`, extension WebSocket bridge, MCP server, HTTP API + dashboard, CLI, headless simulator. |
| **Testing** | `packages/testing` | jsdom **fake chat sites** for all six providers + harness helpers. |
| **Extension** | `packages/extension` | WXT-built MV3 extension: background (tabs + bridge), content script (page agent), popup, options, sandboxed plugin host. |
| **Plugins** | `plugins/*` | One folder per provider: `plugin.json` (metadata + selectors) and optionally `adapter.ts`. |

Five design decisions make the whole thing work:

1. **DOM-driver indirection.** Adapters never touch `document`. They call a `DomDriverLike`
   (`query`, `type`, `click`, `observeText`, …) that exists in three forms: a local driver
   (content script / jsdom), a remote driver (RPC `dom.call`, used by the extension sandbox)
   and the simulator driver. The *same adapter object* runs in a tab, in a sandbox or in CI.
2. **Declarative first.** A provider is a selector pack (candidate lists, try-in-order) plus
   metadata. `SelectorAdapter` turns that into a full adapter with streaming detection,
   provider-agnostic stop/upload/new-chat handling. Code is the escape hatch, not the default.
3. **Sessions, not tabs, in core.** `SessionProvider` abstracts "something that owns pages"
   (Chrome tabs, the simulator, a sandbox). `WorkerManager` maps page → plugin → adapter →
   worker and runs one task per worker while parallelising across workers.
4. **One RPC everywhere.** WebSocket (runtime ⇄ extension), `chrome.runtime.Port` (background ⇄
   content), `postMessage` (sandbox) all speak the same envelope, so error propagation,
   timeouts and streaming behave identically on every hop.
5. **Plugins are data until they need to be code.** `plugin.json` is validated, matched against
   URLs and instantiated without executing anything; a code plugin adds `adapter.ts` and is
   bundled at build time. Third-party manifests can be installed at runtime and run in the
   extension sandbox, never in the page.

## 3. Quick start

```bash
git clone <this repo> && cd BrowserMind
npm install                # also runs `npm run plugins:sync` (regenerates the extension index)
npm run demo               # headless acceptance run — no browser, no agent needed
```

Expected tail of `npm run demo`:

```
✔ 1. Workers registered from plugin folders
✔ 2. send_message → streaming answer
✔ 3. Parallel workers (one tab per provider)
✔ 4. Snapshot exposes capabilities, not selectors
✔ 5. New provider installed at runtime (browser_ai_install_plugin)
✔ 6. The freshly installed provider actually drives a page
✔ 7. Agent-visible surface stayed identical

Acceptance: 7/7 checks passed in <N>ms
```

**Drive it from an agent.** Add to Claude Desktop / Cursor (`claude_desktop_config.json`,
`mcp.json`, …), using absolute paths:

```jsonc
{
  "mcpServers": {
    "browsermind": {
      "command": "node",
      "args": ["--import", "tsx", "/abs/path/BrowserMind/packages/runtime/src/cli.ts",
               "mcp", "--simulate", "all"]     // drop --simulate to use real browser tabs
    }
  }
}
```

**Drive real browser tabs.** Three terminals:

```bash
npm run serve                    # runtime: extension bridge ws://127.0.0.1:8765 + dashboard :8787
npm run ext:build                # build the extension into packages/extension/.output/chrome-mv3
# chrome://extensions → Developer mode → Load unpacked → pick that folder
```

Open a chat page (e.g. `https://chat.deepseek.com`), click the BrowserMind popup — it shows the
worker and the runtime link. The runtime URL lives in the extension's options page
(default `ws://127.0.0.1:8765/browsermind/extension`). Now `browser_ai_list_workers` returns the
real tab, e.g. `deepseek-1`, and prompts run in that page.

## 4. Writing a plugin

A declarative provider is **one JSON file** — no build step, no core change:

```jsonc
// plugins/gemini/plugin.json  (shipped in this repo)
{
  "id": "gemini",
  "name": "Gemini Web",
  "version": "1.0.0",
  "matchPatterns": ["https://gemini.google.com/*"],
  "capabilities": ["chat", "file_upload", "image_input", "search", "stop", "new_chat"],
  "selectors": {
    "input": ["rich-textarea .ql-editor", "div[contenteditable='true']"],
    "sendButton": ["button.send-button", "button[aria-label*='Send']"],
    "response": ["model-response message-content .markdown"],
    "streaming": ["model-response [data-test-id='thinking']"],
    "stopButton": ["button[aria-label*='Stop']"],
    "newChat": ["a[href='/app']"]
  }
}
```

`npm run plugins:sync` picks the folder up, regenerates
`packages/extension/src/generated/plugin-manifests.ts` (host permissions + content-script
matches) and the extension build includes it. `npx tsx scripts/check-plugins.ts` proves it works
against a fake page — that is exactly how Gemini and Grok are tested here.

For a provider that needs real logic, add `adapter.ts` next to the manifest:

```ts
import { SelectorAdapter, type PluginContext } from '@browsermind/core/browser';
import { pack } from './selectors';

export function createAdapter(context: PluginContext) {
  return new SelectorAdapter(context, pack, { id: 'myprovider', name: 'My Provider', version: '1.0.0' });
}
```

Interfaces (both frozen for plugins, defined in `packages/core/src/types.ts`):

```ts
interface BrowserAIPlugin {
  id: string; name: string; version: string;
  match(url: string): boolean;
  capabilities(): string[];
  createAdapter(context: PluginContext): AIAdapter;
  describe(): PluginDescriptor;
}

interface AIAdapter {
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
  waitForResponse(options?: WaitForResponseOptions): Promise<string>;
  getStatus(): Promise<'ready' | 'busy' | 'waiting' | 'blocked' | 'offline'>;
  snapshot(): Promise<PageSnapshot>;
  capabilities(): string[] | Promise<string[]>;
  stop?(): Promise<void>;
  newChat?(): Promise<unknown>;
  invoke?(actionId: string, value?: unknown): Promise<unknown>;
  transcript?(): Promise<TranscriptEntry[]>;
}
```

Installing a third-party manifest at runtime (agent-driven, no rebuild):

```bash
browsermind install ./my-provider.json --persist   # → plugins/my-provider/plugin.json
# or, from an agent: browser_ai_install_plugin { manifest: { … } }
```

### Third-party plugins and trust

| Stage | What happens |
| --- | --- |
| **Install** | `browsermind install manifest.json --persist` (or `browser_ai_install_plugin` from an agent) validates the manifest, writes `plugins/<id>/plugin.json` and broadcasts the catalog to every connected extension. |
| **Mirror** | The background worker stores the manifest; the options page lists it with a **Grant** button. A plugin only ever sees pages whose patterns were granted (`optional_host_permissions`). |
| **Activate** | Granting registers a content script for exactly those patterns at runtime (`chrome.scripting.registerContentScripts`) — no rebuild, no restart. |
| **Execute** | Declarative plugins are pure data. Code plugins are either bundled at build time (reviewable in this repo) or hosted in the extension **sandbox**, which has no page access at all: the DOM is reached through the tunneled `dom.call` RPC. |

| Provider | Plugin | Patterns | Capabilities |
| --- | --- | --- | --- |
| ChatGPT | `plugins/chatgpt` (code) | `chatgpt.com/*`, `chat.openai.com/*` | chat, file_upload, image_input, stop, new_chat, tools |
| Claude | `plugins/claude` (code) | `claude.ai/*` | chat, file_upload, image_input, stop, new_chat, artifacts |
| DeepSeek | `plugins/deepseek` (code) | `chat.deepseek.com/*` | chat, file_upload, stop, new_chat, deep_think, search |
| Gemini | `plugins/gemini` (**json only**) | `gemini.google.com/*` | chat, file_upload, image_input, search, stop, new_chat |
| Grok | `plugins/grok` (**json only**) | `grok.com/*`, `x.com/i/grok*` | chat, file_upload, image_input, search, stop, new_chat |
| Mock | `plugins/mock` (code) | `mock.browsermind.local/*` | chat, file_upload, stop, new_chat |

## 5. Repository layout

```
packages/core        contracts, registry, worker manager, DOM drivers, RPC, session protocol
packages/runtime     BrowserAIRuntime, extension bridge, MCP server, HTTP + dashboard, CLI, simulator
packages/testing     jsdom fake sites for every provider + harness
packages/extension   WXT MV3 extension (background, content, popup, options, sandbox)
plugins/*            one folder per provider (plugin.json ± adapter.ts)
scripts/             generate-plugin-index.mjs + the checks used by the verification checklist
tests/               vitest suite (contracts, plugins vs fake sites, workers, runtime↔extension wire)
```

## 6. Verification checklist

Everything below is reproducible on a clean machine (Node ≥ 20, npm, no Chrome for steps 1–6).
Copy-paste the block, or run the single aggregate command at the end.

```bash
npm install                 # 1. install + regenerate the plugin index
npm run typecheck           # 2. zero type errors (runtime + extension projects)
npm test                    # 3. 57 tests / 5 files
npm run check:plugins       # 4. every provider against its fake page → 6/6 providers OK
npm run check:entries       # 5. both core entries + runtime entry → 8/8 entry-point checks OK
npm run demo                # 6. end-to-end acceptance → Acceptance: 7/7 checks passed
npm run ext:build           # 7. MV3 build → packages/extension/.output/chrome-mv3
npm run check:mcp           # 8. real MCP client over stdio → MCP round trip OK
```

| # | Command | Expected result | What it proves |
| --- | --- | --- | --- |
| 1 | `npm install` | `postinstall` runs `plugins:sync` | a new plugin folder is picked up automatically |
| 2 | `npm run typecheck` | exit 0, no output | core/runtime/plugins/tests **and** the extension typecheck |
| 3 | `npm test` | `Tests 57 passed (57)` | see the table below |
| 4 | `npm run check:plugins` | `6/6 providers OK`, `PASS <id>: status=ready …` | every plugin drives a page: typing, submitting, streaming, capabilities |
| 5 | `npm run check:entries` | `8/8 entry-point checks OK` | `@browsermind/core/browser` stays browser-safe, runtime entry loads |
| 6 | `npm run demo` | `Acceptance: 7/7 checks passed in …ms` | multiple workers in parallel, runtime plugin install, stable agent surface |
| 7 | `npm run ext:build` | `Built extension`, `Σ Total size: 147.27 kB` | MV3 manifest: host permissions + content-script matches generated from plugins, sandbox page |
| 8 | `npm run check:mcp` | `MCP round trip OK` | an MCP client lists 13 tools, sends a message, snapshots, installs a plugin |

What the test suite (step 3) covers:

| File | Tests | Proves |
| --- | --- | --- |
| `tests/match-pattern.test.ts` | 5 | URL → plugin resolution, wildcards, specificity ordering |
| `tests/registry.test.ts` | 5 | register/resolve/enable/uninstall, manifest validation, no provider branching |
| `tests/plugins.test.ts` | 30 | all six providers against their fake sites: send, stream, stop, upload, snapshot has **no selectors**, login wall, stalled provider, broken selector candidates |
| `tests/worker-manager.test.ts` | 9 | worker ids, async `send_message`/`get_response`, task serialisation per worker, parallelism across workers, typed errors |
| `tests/extension-bridge.test.ts` | 8 | the runtime ⇄ extension protocol over a **real WebSocket**: session list, remote task with streamed progress, DOM tunnel, late tab, plugin catalog push, disconnect cleanup |

Optional extras:

```bash
npm run serve                          # dashboard http://127.0.0.1:8787 + bridge ws://127.0.0.1:8765
curl -s localhost:8787/api/health      # same JSON the tools return
curl -N localhost:8787/api/events      # SSE stream of worker/plugin events
npm run dev:runtime                    # watch mode with `--simulate all`
npx tsx scripts/check-plugins.ts --dir ./my-plugins   # point the plugin check at your own folder

# no provider branching in core: every hit below is a comment or a tool description
grep -rniE "deepseek|chatgpt|claude|gemini|grok" packages/core/src packages/runtime/src
```

Aggregate: **`npm run verify`** runs 2 → 8 in order (`typecheck`, `test`, `check:plugins`,
`check:entries`, `demo`, `ext:build`, `check:mcp`).

### Not covered by the checklist

Honest scope limits — everything here is by design, not an accident:

- **No real-browser automation.** This repo has no Chrome; the extension build, its manifest,
  the sandbox page and every message handler are typechecked and built, but the final
  `chrome://extensions` walkthrough is manual (section 3).
- **Live sites change.** Selectors are re-verified against the fake sites, not the internet.
  A provider whose markup moved is fixed in one file (`plugins/<id>/selectors.ts`), never in core.
- **First-run permissions.** The extension ships host permissions for the shipped providers;
  a runtime-installed plugin's pattern must be granted from the options page
  (`optional_host_permissions: ["<all_urls>"]`) before its content script activates.

## 7. Configuration

| CLI flag | Default | Meaning |
| --- | --- | --- |
| `--plugins <dir>` | `./plugins` | plugin folder to scan |
| `--port <n>` | `8765` | extension bridge port (WebSocket) |
| `--http-port <n>` | `8787` | HTTP API + dashboard port |
| `--simulate <a,b\|all>` | — | run providers headlessly (no browser) |
| `--log-level <l>` | `info` | `debug \| info \| warn \| error \| silent` |
| `--persist` | — | `install`: write `plugins/<id>/plugin.json` |

Runtime options (`BrowserAIRuntime.create({ … })`): `pluginDir`, `plugins`, `simulate`,
`extensionPort`, `startBridge`, `statusPollMs`, `taskTimeoutMs`, `logger`, `logLevel`.
Extension options page: runtime WebSocket URL, per-plugin host permission grants, plugin install
(local manifest, optionally pushed to the runtime), sandbox opener, logs.

## 8. Design notes

- **Why MCP + a runtime instead of "an agent that clicks the page"?** The tab belongs to the
  user; the runtime owns session lifetime, parallelism, retries and streaming, and exposes a
  stable tool contract that survives UI refactors. Agents stay simple, providers stay swappable.
- **Why never a selector in the API?** Selectors are an implementation detail of *one* provider
  and change weekly. The agent gets `capabilities`, `availableActions` and `snapshot.state`;
  `invoke_action("toggle-deep-think")` is a capability name, not a CSS query.
- **Why the DOM-driver hop?** It is the only way the same adapter runs in a page, in a sandbox
  (no DOM access, everything tunneled as RPC) and in jsdom during CI — and it makes selectors
  testable without a browser.
- **Failure honesty.** A page that shows a login wall reports `status: blocked`; a provider that
  stops mid-answer returns `partial: true` with the streamed text; a worker never silently
  pretends to be ready.
