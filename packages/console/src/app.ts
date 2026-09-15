/**
 * The standalone BrowserMind console — one page, two hosts.
 *
 * `mountConsole()` renders the whole UI against a `ConsoleTransport`, so the same
 * source runs as
 *   - a normal web page served by `browsermind serve` (HTTP + SSE), and
 *   - a full tab inside the Chrome extension (background RPC + bridge events).
 *
 * There is deliberately no popup here: a human driving a fleet of workers needs a
 * page, not a 380px widget that dies the moment you click somewhere else.
 */
import { clear, errorMessage, h, mount, statusLabel, time } from './dom.js';
import type { ConsoleActions } from './state.js';
import { createConsoleState } from './state.js';
import type { ChatMessage, ConsoleTransport, PluginRow, SessionRow, SnapshotRow, WorkerRow } from './types.js';

export interface MountOptions {
  /** Host-specific header control, e.g. the runtime origin field on the web host. */
  headerExtra?: (actions: ConsoleActions) => HTMLElement | null;
  /** Called once after the first refresh, so hosts can log/trace booting. */
  onMount?: (actions: ConsoleActions) => void;
}

export interface ConsoleHandle {
  actions: ConsoleActions;
  destroy(): void;
}

const EXAMPLE_MANIFEST = `{
  "id": "acme-chat",
  "name": "ACME Chat",
  "version": "1.0.0",
  "matchPatterns": ["https://chat.example.com/*"],
  "capabilities": ["chat", "stop", "new_chat"],
  "selectors": {
    "input": ["#prompt-textarea", "textarea"],
    "sendButton": ["button[data-testid='send-button']"],
    "submitKeys": ["Enter"],
    "response": [".message.assistant .markdown"],
    "streaming": ["button[data-testid='stop-button']:not([hidden])"],
    "stopButton": ["button[data-testid='stop-button']:not([hidden])"],
    "ready": ["#prompt-textarea"]
  }
}`;

export function mountConsole(root: HTMLElement, transport: ConsoleTransport, options: MountOptions = {}): ConsoleHandle {
  const actions = createConsoleState(transport);
  const store = actions.store;

  /* ------------------------------- skeleton ------------------------------- */

  const pills = {
    host: h('span', { class: 'pill' }, transport.label),
    runtime: h('span', { class: 'pill' }, 'runtime: …'),
    workers: h('span', { class: 'pill' }, 'workers: …'),
    plugins: h('span', { class: 'pill' }, 'plugins: …'),
    live: h('span', { class: 'pill' }, '事件: …'),
  };
  const headerExtra = options.headerExtra?.(actions) ?? null;
  const header = h(
    'header',
    {},
    h('div', { class: 'brand' }, h('strong', {}, 'BrowserMind'), h('span', { class: 'sub' }, '独立控制台 · Browser AI Worker Runtime')),
    h('div', { class: 'pills' }, pills.host, pills.runtime, pills.workers, pills.plugins, pills.live),
    h(
      'div',
      { class: 'actions' },
      headerExtra,
      h('button', { class: 'ghost', onclick: () => void actions.refresh() }, '刷新'),
      transport.reconnect ? h('button', { class: 'ghost', onclick: () => void actions.reconnect() }, '重连') : null,
    ),
  );

  const workerList = h('div', { class: 'stack', id: 'worker-list' });
  const sessionList = h('div', { class: 'stack', id: 'session-list' });
  const providerRow = h('div', { class: 'chips', id: 'provider-row' });
  const chat = {
    head: h('div', { class: 'chat-head' }),
    thread: h('div', { class: 'thread', id: 'thread' }),
    composer: h('textarea', {
      id: 'composer',
      placeholder: '给选中的 worker 下指令，例如：总结我上一段对话里的待办事项',
      spellcheck: 'false',
    }) as HTMLTextAreaElement,
    files: h('input', { type: 'file', multiple: true, id: 'files', class: 'file' }) as HTMLInputElement,
    send: h('button', { class: 'primary', type: 'button' }, '发送') as HTMLButtonElement,
    hint: h('div', { class: 'hint' }),
  };
  const inspector = h('div', { class: 'body', id: 'inspector' });
  const logPanel = h('div', { class: 'log', id: 'event-log' });
  const pluginTable = h('div', { id: 'plugin-table' });
  const manifestBox = h('textarea', { class: 'code', spellcheck: 'false' }) as HTMLTextAreaElement;
  manifestBox.value = EXAMPLE_MANIFEST;
  const persistBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const installNote = h('div', { class: 'note' });
  const quickStart = h('div', { class: 'body' });
  const diagnostics = h('div', { class: 'body', id: 'diagnostics' });
  const agentDocs = h('div', { class: 'body' });

  const tabs: Array<{ id: string; label: string; node: HTMLElement }> = [
    { id: 'doctor', label: '自检', node: h('div', { class: 'tab' }, diagnostics) },
    { id: 'log', label: '事件日志', node: h('div', { class: 'tab' }, logPanel) },
    {
      id: 'plugins',
      label: 'Provider 插件',
      node: h(
        'div',
        { class: 'tab' },
        pluginTable,
        h('h3', {}, '安装一个新 provider（只填 manifest，不改核心代码）'),
        h('p', { class: 'muted' }, '粘贴 plugin.json（manifest + selector pack）。安装后 runtime 立刻能用它匹配页面，扩展会在下次页面加载时注入 content script。'),
        manifestBox,
        h(
          'div',
          { class: 'row' },
          h('label', { class: 'check' }, persistBox, '写入 plugins/ 目录（重启后仍在）'),
          h('button', {
            class: 'primary',
            onclick: () => void actions.installManifest(manifestBox.value, persistBox.checked),
          }, '安装'),
        ),
        installNote,
      ),
    },
    { id: 'start', label: '快速开始', node: h('div', { class: 'tab' }, quickStart) },
    { id: 'agent', label: 'Agent 接入', node: h('div', { class: 'tab' }, agentDocs) },
  ];
  const tabBodies = h('div', { class: 'tab-bodies' }, ...tabs.map((tab) => h('div', { class: 'tab', 'data-tab': tab.id, hidden: tab.id !== 'doctor' }, tab.node)));
  function activateTab(id: string): void {
    const buttons = Array.from(tabBar.children) as HTMLElement[];
    const index = tabs.findIndex((tab) => tab.id === id);
    buttons.forEach((button, position) => button.classList.toggle('active', position === index));
    for (const body of Array.from(tabBodies.children)) body.toggleAttribute('hidden', (body as HTMLElement).dataset.tab !== id);
  }
  const tabBar = h(
    'div',
    { class: 'tab-bar' },
    ...tabs.map((tab) =>
      h('button', { class: `tab-link${tab.id === 'doctor' ? ' active' : ''}`, onclick: () => activateTab(tab.id) }, tab.label),
    ),
  );

  const main = h(
    'main',
    {},
    h(
      'section',
      { class: 'panel workers' },
      h('h2', {}, 'Workers'),
      h('div', { class: 'body' }, workerList, h('h3', {}, '打开 Provider'), providerRow, transport.listSessions ? h('h3', {}, '已连接的页面') : null, transport.listSessions ? sessionList : null),
    ),
    h('section', { class: 'panel chat' }, h('h2', {}, '对话'), h('div', { class: 'body chat-body' }, chat.head, chat.thread, renderComposer(chat))),
    h('section', { class: 'panel inspector' }, h('h2', {}, '页面快照 / 动作'), inspector),
  );

  mount(root,     h('div', { class: 'shell' }, header, main, h('section', { class: 'panel bottom' }, tabBar, tabBodies), h('footer', { class: 'foot' }, 'BrowserMind — worker 视角就是 agent 视角：这里没有 selector，也没有 DOM。')),
  );

  function renderComposer(box: typeof chat): HTMLElement {
    const row = h(
      'div',
      { class: 'row' },
      box.send,
      h('button', { class: 'ghost', type: 'button', onclick: () => void actions.stop() }, '停止生成'),
      h('button', { class: 'ghost', type: 'button', onclick: () => void actions.newChat() }, '新会话'),
      h('button', { class: 'ghost', type: 'button', onclick: () => void actions.loadSnapshot() }, '刷新快照'),
      h('button', { class: 'ghost danger', type: 'button', onclick: () => void actions.closeWorker() }, '关闭 worker'),
    );
    box.composer.addEventListener('keydown', (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === 'Enter' && (keyEvent.metaKey || keyEvent.ctrlKey)) {
        keyEvent.preventDefault();
        submit();
      }
      if (keyEvent.key === 'Escape') void actions.stop();
    });
    box.send.addEventListener('click', submit);
    async function submit(): Promise<void> {
      const text = box.composer.value.trim();
      if (!text) return;
      const files = await readFiles(box.files);
      box.composer.value = '';
      box.files.value = '';
      await actions.send(text, files.length ? { files } : undefined);
    }
    return h('div', { class: 'composer' }, box.composer, row, box.files, box.hint);
  }

  /* -------------------------------- render -------------------------------- */

  /** true once the first settled refresh has been shown (used to auto-open 自检). */
  let booted = false;
  const unsubscribe = store.subscribe((state) => {
    pills.host.textContent = transport.label;
    pills.runtime.textContent = state.reachable ? 'runtime: 已连接' : 'runtime: 不可达';
    pills.runtime.className = `pill ${state.reachable ? 'ok' : 'err'}`;
    pills.workers.textContent = `workers: ${state.workers.length}`;
    pills.plugins.textContent = `plugins: ${state.plugins.length}`;
    pills.live.textContent = `事件: ${state.live ? '实时' : '轮询'}`;
    pills.live.className = `pill ${state.live ? 'ok' : 'warn'}`;

    renderWorkers(state.workers, state.selected, actions);
    renderChat(state.selected ? (state.threads[state.selected] ?? []) : [], state.workers.find((w) => w.id === state.selected), state.running[state.selected ?? ''], state.sending);
    renderInspector(state.snapshot, state.snapshotError, state.selected, actions);
    renderSessions(state.sessions, transport);
    renderProviders(state.plugins, actions, transport);
    mount(logPanel, state.log.map((line) => h('div', {}, `${time(line.at)}  ${line.text}`)));
    renderPluginTable(state.plugins, state.installNote, state.installing);
    renderDiagnostics(state, transport);
    chat.hint.textContent = state.lastError ? `最近错误：${state.lastError}` : '⌘/Ctrl + Enter 发送，Esc 停止';
    chat.hint.className = `hint${state.lastError ? ' err' : ''}`;
    chat.send.disabled = state.sending || !state.selected;
    chat.send.textContent = state.sending ? '生成中…' : '发送';
    // A page that cannot do anything yet should say why, unprompted.
    if (!booted && !state.refreshing && (!state.reachable || !state.workers.length)) {
      booted = true;
      activateTab('doctor');
    } else if (!state.refreshing) {
      booted = true;
    }
  });

  function renderWorkers(workers: WorkerRow[], selected: string | undefined, act: ConsoleActions): void {
    if (!workers.length) {
      mount(workerList,         h('div', { class: 'empty' }, '还没有 worker。左边点一个 provider 打开页面，或在启动 runtime 时加 ', h('code', {}, '--simulate all'), '。'),
      );
      return;
    }
    mount(workerList,       ...workers.map((worker) =>
        h(
          'div',
          {
            class: `worker ${worker.status}${worker.id === selected ? ' selected' : ''}`,
            onclick: () => act.select(worker.id),
            role: 'button',
            tabindex: '0',
          },
          h('div', { class: 'row' }, h('span', { class: `dot ${worker.status}` }), h('strong', {}, worker.id), h('span', { class: 'pill tiny' }, statusLabel(worker.status))),
          h('div', { class: 'muted' }, `${worker.provider} · ${worker.location}${worker.tabId ? ` · tab ${worker.tabId}` : ''}`),
          h('div', { class: 'caps' }, (worker.capabilities ?? []).join(' · ') || '无 capability'),
          worker.url ? h('div', { class: 'muted truncate' }, worker.url) : null,
          h('div', { class: 'muted' }, `任务 ${worker.tasks.total} · 完成 ${worker.tasks.completed} · 失败 ${worker.tasks.failed}${worker.tasks.current ? ` · 运行中 ${worker.tasks.current}` : ''}`),
          worker.lastError ? h('div', { class: 'err-text' }, worker.lastError) : null,
        ),
      ),
    );
  }

  function renderChat(messages: ChatMessage[], worker: WorkerRow | undefined, runningTask: string | undefined, sending: boolean): void {
    if (!worker) {
      mount(chat.head, h('span', { class: 'muted' }, '未选择 worker'));
      mount(chat.thread, h('div', { class: 'empty' }, '选一个 worker，或打开一个 provider 页面。'));
      return;
    }
    mount(chat.head,       h('strong', {}, worker.id),
      h('span', { class: 'pill tiny' }, statusLabel(worker.status)),
      runningTask ? h('span', { class: 'pill tiny busy' }, `生成中 ${runningTask}`) : null,
      h('span', { class: 'muted truncate' }, worker.url ?? ''),
      h('span', { class: 'spacer' }),
      sending ? h('span', { class: 'muted' }, '等待回答…') : null,
    );
    const nearBottom = chat.thread.scrollHeight - chat.thread.scrollTop - chat.thread.clientHeight < 120;
    if (!messages.length) {
      mount(chat.thread, h('div', { class: 'empty' }, '这个 worker 的对话还是空的。发一条消息，或点下面的 capability 动作。'));
      return;
    }
    mount(chat.thread,       ...messages.map((message) =>
        h(
          'div',
          { class: `msg ${message.role}${message.streaming ? ' streaming' : ''}` },
          h(
            'div',
            { class: 'meta' },
            h('span', {}, message.role === 'user' ? '你' : message.role === 'assistant' ? worker.provider : 'system'),
            message.taskId ? h('code', {}, message.taskId) : null,
            message.durationMs ? h('span', {}, `${message.durationMs}ms`) : null,
            message.streaming ? h('span', { class: 'muted' }, 'streaming…') : null,
            h('button', {
              class: 'link',
              onclick: () => void navigator.clipboard?.writeText(message.text).catch(() => undefined),
            }, '复制'),
          ),
          message.role === 'user' ? h('div', { class: 'text' }, message.text) : renderMarkdown(message.text),
          message.note ? h('div', { class: 'note' }, message.note) : null,
        ),
      ),
    );
    if (nearBottom) chat.thread.scrollTop = chat.thread.scrollHeight;
  }

  function renderInspector(snapshot: SnapshotRow | null, error: string | undefined, worker: string | undefined, act: ConsoleActions): void {
    if (!worker) {
      mount(inspector, h('div', { class: 'empty' }, '没有选中 worker。'));
      return;
    }
    if (error) {
      mount(inspector, h('div', { class: 'err-text' }, `快照失败：${error}`), h('button', { class: 'ghost', onclick: () => void act.loadSnapshot() }, '重试'));
      return;
    }
    if (!snapshot) {
      mount(inspector, h('div', { class: 'muted' }, '正在读取快照…'));
      return;
    }
    const actions = snapshot.availableActions ?? [];
    mount(inspector,       h('div', { class: 'kv' }, h('span', {}, 'state'), h('code', {}, snapshot.state), h('span', {}, 'status'), h('code', {}, snapshot.status), h('span', {}, 'busy'), h('code', {}, String(snapshot.busy))),
      h('div', { class: 'kv' }, h('span', {}, 'capabilities'), h('code', {}, (snapshot.capabilities ?? []).join(', ') || '—')),
      snapshot.url ? h('div', { class: 'kv' }, h('span', {}, 'url'), h('code', { class: 'truncate' }, snapshot.url)) : null,
      h('h3', {}, 'Page actions'),
      actions.length
        ? h(
            'div',
            { class: 'chips' },
            ...actions.map((action) =>
              h(
                'button',
                {
                  class: `chip action ${action.kind}${action.enabled ? '' : ' off'}${action.value ? ' on' : ''}`,
                  disabled: !action.enabled,
                  title: action.reason ?? action.id,
                  onclick: () => void act.invoke(action.id),
                },
                action.kind === 'toggle' ? `${action.label} ${action.value ? '开' : '关'}` : action.label,
              ),
            ),
          )
        : h('div', { class: 'muted' }, '这个 provider 没有声明额外动作。'),
      h('h3', {}, 'Transcript'),
      h(
        'div',
        { class: 'transcript' },
        ...(snapshot.transcript?.length
          ? snapshot.transcript.map((entry) => h('div', { class: `t ${entry.role}` }, h('span', {}, entry.role), h('div', {}, entry.text.slice(0, 600))))
          : [h('div', { class: 'muted' }, '页面还没有对话。')]),
      ),
      h('details', {}, h('summary', {}, '原始快照 JSON'), h('pre', { class: 'code' }, JSON.stringify(snapshot, null, 2))),
    );
  }

  function renderSessions(sessions: SessionRow[], host: ConsoleTransport): void {
    if (!host.listSessions) return;
    if (!sessions.length) {
      mount(sessionList, h('div', { class: 'empty' }, '没有页面被接管。在 DeepSeek / ChatGPT / Claude / Gemini / Grok 的对话页里，扩展会自动接管它。'));
      return;
    }
    mount(sessionList,       ...sessions.map((session) =>
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'row' }, h('strong', {}, session.pluginId), h('span', { class: 'pill tiny' }, session.location), h('span', { class: 'muted' }, `tab ${session.tabId ?? '?'}`)),
          h('div', { class: 'muted truncate' }, session.title ?? ''),
          h('div', { class: 'muted truncate' }, session.url),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'ghost tiny', onclick: () => void host.tabAction?.('focus', Number(session.tabId)) }, '聚焦'),
            h('button', { class: 'ghost tiny', onclick: () => void host.tabAction?.('highlight', Number(session.tabId)) }, '高亮输入框'),
            h('button', { class: 'ghost tiny danger', onclick: () => void host.tabAction?.('close', Number(session.tabId)) }, '关闭'),
          ),
        ),
      ),
    );
  }

  function renderProviders(plugins: PluginRow[], act: ConsoleActions, host: ConsoleTransport): void {
    const ids = [...new Set(plugins.map((plugin) => plugin.id).filter((id) => id !== 'mock'))];
    mount(providerRow,       ...ids.map((id) =>
        h('button', { class: 'chip', onclick: () => void act.openProvider(id) }, `打开 ${id}`),
      ),
      ids.length ? h('button', { class: 'chip ghost', onclick: () => void act.openProvider('mock') }, '打开 mock') : null,
      host.openLink ? h('button', { class: 'chip ghost', onclick: () => host.openLink?.(`${location.origin}/dashboard`) }, '调试面板') : null,
    );
  }

  function renderPluginTable(plugins: PluginRow[], note: { ok: boolean; text: string } | undefined, installing: boolean): void {
    mount(pluginTable,       h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Provider'), h('th', {}, '匹配规则'), h('th', {}, 'Capabilities'), h('th', {}, '来源'))),
        h(
          'tbody',
          {},
          ...plugins.map((plugin) =>
            h(
              'tr',
              {},
              h('td', {}, h('code', {}, plugin.id), h('div', { class: 'muted' }, `${plugin.name} v${plugin.version}`)),
              h('td', { class: 'muted' }, (plugin.matchPatterns ?? []).join(' · ') || '—'),
              h('td', { class: 'muted' }, (plugin.capabilities ?? []).join(', ') || '—'),
              h('td', {}, h('span', { class: 'pill tiny' }, plugin.source ?? 'builtin')),
            ),
          ),
        ),
      ),
    );
    installNote.textContent = note?.text ?? '';
    installNote.className = `note ${note ? (note.ok ? 'ok' : 'err') : ''}`;
    if (installing) installNote.textContent = '安装中…';
  }

  function renderDiagnostics(state: ReturnType<typeof store.get>, host: ConsoleTransport): void {
    const hints: Array<{ level: 'ok' | 'warn' | 'err'; text: string }> = [];
    if (!state.reachable) {
      hints.push({ level: 'err', text: '连不上 runtime。先跑 `npm run serve`（默认 http://127.0.0.1:8787），本页就是这个服务提供的。' });
    } else {
      hints.push({ level: 'ok', text: `runtime 可达，插件 ${state.plugins.length} 个。` });
    }
    const extension = state.health?.extension;
    if (host.kind === 'web') {
      hints.push(
        extension && extension.connected > 0
          ? { level: 'ok', text: `扩展已连接（${extension.connected} 个客户端，bridge :${extension.port}），真实页面可用。` }
          : { level: 'warn', text: '还没有浏览器扩展连上来：`npm run ext:build` 后在 chrome://extensions 里 Load unpacked 选 packages/extension/.output/chrome-mv3。' },
      );
    }
    if (!state.workers.length) {
      hints.push({ level: 'warn', text: '没有 worker，所以现在无法发消息。想先看到效果：`npm run serve -- --simulate all`（6 个假页面，零浏览器）。' });
    }
    const blocked = state.workers.filter((worker) => worker.status === 'blocked' || worker.status === 'offline');
    if (blocked.length) {
      hints.push({ level: 'warn', text: `${blocked.map((worker) => worker.id).join(', ')} 处于 ${blocked[0]?.status}：需要人工处理（登录 / 配额 / 页面已关）。` });
    }
    if (!state.live) hints.push({ level: 'warn', text: '实时事件未连接，当前用 4 秒轮询（流式回答会显得一跳一跳）。' });
    mount(diagnostics,       h('div', { class: 'hints' }, ...hints.map((hint) => h('div', { class: `hint-line ${hint.level}` }, hint.text))),
      h(
        'details',
        {},
        h('summary', {}, '原始 health'),
        h('pre', { class: 'code' }, JSON.stringify(state.health, null, 2)),
      ),
    );
  }

  mount(quickStart,     h('ol', { class: 'steps' },
      h('li', {}, h('code', {}, 'npm install'), ' —— 装依赖并构建本页（postinstall 自动跑 console:build）'),
      h('li', {}, h('code', {}, 'npm run serve -- --simulate all'), ' —— 打开 ', h('a', { href: '/' }, 'http://127.0.0.1:8787'), '，立刻有 6 个 worker 可以聊'),
      h('li', {}, h('code', {}, 'npm run ext:build'), ' —— chrome://extensions 里 Load unpacked 选 ', h('code', {}, 'packages/extension/.output/chrome-mv3'), '，点工具栏图标就是这个独立页面'),
      h('li', {}, '打开一个 AI 对话页，扩展会自动把它注册成 worker；这个页面里就能选它对话'),
    ),
    h('p', { class: 'muted' }, '这一页只是 runtime 的普通客户端：所有操作都是 ', h('code', {}, 'browser_ai_*'), ' 工具，和 agent 用的完全一样。'),
  );

  mount(agentDocs,     h('p', { class: 'muted' }, '把这个 runtime 接给 Claude Desktop / Cursor / 任何 MCP 客户端；它们看到的和你在这里看到的是一回事。'),
    h('pre', { class: 'code' }, mcpSnippet()),
    h('p', { class: 'muted' }, '不用 MCP 也行，直接打 REST：'),
    h('pre', { class: 'code' }, restSnippet()),
  );

  /* ------------------------------- live wiring ------------------------------ */

  const unsubscribeEvents = transport.subscribe?.((event) => actions.onEvent(event));
  const poll = setInterval(() => {
    if (!store.get().live) void actions.refresh();
  }, 4_000);
  const boot = setInterval(() => void actions.refresh(), 2_000);

  void actions.refresh().then(() => options.onMount?.(actions));
  void loadContext();
  async function loadContext(): Promise<void> {
    try {
      const context = await transport.call<{ guide?: string; tools?: Array<{ name: string; title: string; description: string; http: string }> }>('browser_ai_worker_context', {});
      const tools = context.tools ?? [];
      agentDocs.insertBefore(
        h(
          'div',
          {},
          h('h3', {}, `${tools.length} 个工具（MCP / REST 同一套）`),
          h(
            'table',
            {},
            h('tbody', {}, ...tools.map((tool) => h('tr', {}, h('td', {}, h('code', {}, tool.name)), h('td', { class: 'muted' }, tool.description), h('td', {}, h('code', {}, tool.http))))),
          ),
        ),
        agentDocs.children[2] ?? null,
      );
      quickStart.appendChild(h('details', {}, h('summary', {}, 'Agent 使用说明书（browser_ai_worker_context）'), h('pre', { class: 'code' }, context.guide ?? '')));
    } catch {
      agentDocs.appendChild(h('div', { class: 'muted' }, '取不到 context：runtime 版本可能过旧。'));
    }
  }

  return {
    actions,
    destroy() {
      unsubscribe();
      unsubscribeEvents?.();
      clearInterval(poll);
      clearInterval(boot);
      clear(root);
    },
  };
}

/* -------------------------------- utilities -------------------------------- */

function mcpSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        browsermind: {
          command: 'node',
          args: ['--import', 'tsx', '<repo>/packages/runtime/src/cli.ts', 'mcp'],
        },
      },
    },
    null,
    2,
  );
}

function restSnippet(): string {
  const origin = typeof location === 'undefined' ? 'http://127.0.0.1:8787' : location.origin;
  return [
    `curl -s ${origin}/api/workers`,
    `curl -s ${origin}/api/health`,
    `curl -N ${origin}/api/events                # SSE：worker / 流式事件`,
    `curl -s -X POST ${origin}/api/send_message \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"worker":"deepseek-1","message":"总结这个项目"}'`,
  ].join('\n');
}

async function readFiles(input: HTMLInputElement): Promise<Array<{ name: string; text: string }>> {
  const files = Array.from(input.files ?? []);
  return Promise.all(
    files.map(async (file) => ({ name: file.name, text: await file.text() })),
  );
}

/**
 * Just enough markdown for a chat answer: headings, bold, inline code, fenced
 * code, lists and links. Input is escaped first, so nothing the page renders can
 * inject markup.
 */
function renderMarkdown(text: string): HTMLElement {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = escaped
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre class="code">${code.replace(/^\n+|\n+$/g, '')}</pre>`)
    .replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`)
    .replace(/^#{1,4}\s+(.+)$/gm, (_m, title: string) => `<h4>${title}</h4>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, bold: string) => `<strong>${bold}</strong>`)
    .replace(/(https?:\/\/[^\s<)]+)/g, (_m, link: string) => `<a href="${link}" target="_blank" rel="noreferrer">${link}</a>`)
    .replace(/(?:^|\n)((?:[-*]\s+.+(?:\n|$))+)/g, (_m, block: string) => {
      const items = block
        .trim()
        .split('\n')
        .map((line) => `<li>${line.replace(/^[-*]\s+/, '')}</li>`)
        .join('');
      return `\n<ul>${items}</ul>`;
    });
  const node = h('div', { class: 'text md' });
  node.innerHTML = html.replace(/\n{3,}/g, '\n\n');
  return node;
}

export { h };
