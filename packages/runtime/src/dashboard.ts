/**
 * The lightweight debug view at `/dashboard`.
 *
 * The real human-facing UI is the standalone console page (`packages/console`,
 * served at `/`); this one stays because it is a 200-line read-only look at the
 * same data that is handy when debugging a runtime from a terminal.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BrowserMind — Browser AI Worker Runtime</title>
<style>
  :root {
    --bg: #0b0f19; --panel: #131a2a; --panel-2: #1b2436; --line: #26304a;
    --text: #e6ebf5; --muted: #8b98b4; --accent: #6d8cff; --ok: #3ddc97; --warn: #ffcf5c; --err: #ff6b6b;
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(1200px 600px at 20% -10%, #141d33 0%, transparent 60%), var(--bg);
    color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.5; }
  header { display: flex; align-items: center; gap: 16px; padding: 18px 24px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .2px; }
  header .brand { font-weight: 700; }
  header .brand span { color: var(--accent); }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); }
  .pill.ok { color: var(--ok); border-color: rgba(61,220,151,.35); }
  .pill.warn { color: var(--warn); border-color: rgba(255,207,92,.35); }
  main { padding: 20px 24px 60px; display: grid; gap: 20px; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  section > h2 { margin: 0; padding: 12px 16px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .body { padding: 14px 16px; }
  .workers { display: grid; gap: 10px; }
  .worker { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--panel-2); }
  .worker.busy { border-color: rgba(109,140,255,.5); }
  .worker.blocked { border-color: rgba(255,107,107,.5); }
  .worker .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .worker .id { font-family: var(--mono); font-weight: 600; }
  .worker .caps { color: var(--muted); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.ready { background: var(--ok); } .dot.busy { background: var(--accent); }
  .dot.blocked, .dot.error { background: var(--err); } .dot.waiting { background: var(--warn); }
  .stream { margin-top: 8px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    max-height: 120px; overflow: auto; white-space: pre-wrap; }
  form { display: grid; gap: 10px; }
  select, textarea, button, input { font: inherit; color: inherit; background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 10px; }
  textarea { min-height: 80px; resize: vertical; }
  button { background: var(--accent); border-color: transparent; color: #08101f; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: var(--muted); border-color: var(--line); font-weight: 500; }
  button:disabled { opacity: .55; cursor: progress; }
  pre.answer { white-space: pre-wrap; font-family: var(--mono); font-size: 12.5px; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 10px; padding: 12px; max-height: 320px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
  code { font-family: var(--mono); color: var(--text); }
  .muted { color: var(--muted); }
  .log { font-family: var(--mono); font-size: 12px; color: var(--muted); max-height: 180px; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1><span class="brand">Browser<span>Mind</span></span> · Browser AI Worker Runtime</h1>
  <span class="pill" id="ext-pill">extension: …</span>
  <span class="pill" id="worker-pill">workers: …</span>
  <span class="pill" id="plugin-pill">plugins: …</span>
</header>
<main>
  <section>
    <h2>Workers — the only thing an agent sees</h2>
    <div class="body workers" id="workers"><p class="muted">Loading…</p></div>
  </section>
  <section>
    <h2>Chat with a worker</h2>
    <div class="body">
      <form id="chat-form">
        <select id="worker-select"></select>
        <textarea id="message" placeholder="分析这个项目">Explain what a Browser AI Worker is, in two sentences.</textarea>
        <div style="display:flex; gap:8px">
          <button type="submit" id="send">Send message</button>
          <button type="button" class="ghost" id="snapshot">Snapshot</button>
          <button type="button" class="ghost" id="newchat">New chat</button>
          <button type="button" class="ghost" id="stop">Stop</button>
        </div>
      </form>
      <h2 style="margin:16px 0 8px; padding:0; border:0; background:transparent">Live stream</h2>
      <div class="log" id="stream">—</div>
      <h2 style="margin:16px 0 8px; padding:0; border:0; background:transparent">Answer</h2>
      <pre class="answer" id="answer">—</pre>
      <h2 style="margin:16px 0 8px; padding:0; border:0; background:transparent">Snapshot</h2>
      <pre class="answer" id="snap" style="max-height:200px">—</pre>
    </div>
  </section>
  <section style="grid-column: 1 / -1">
    <h2>Provider plugins — add a website, not core code</h2>
    <div class="body"><table id="plugins"><tbody><tr><td class="muted">Loading…</td></tr></tbody></table></div>
  </section>
  <section style="grid-column: 1 / -1">
    <h2>Task log</h2>
    <div class="body"><div class="log" id="log">—</div></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { workers: [], selected: null };
const logLines = [];
const log = (line) => { logLines.unshift(new Date().toLocaleTimeString() + '  ' + line); $('log').textContent = logLines.slice(0, 60).join('\\n'); };

function renderWorkers(workers) {
  state.workers = workers;
  const container = $('workers');
  if (!workers.length) {
    container.innerHTML = '<p class="muted">No workers yet. Open a provider tab (extension) or start with <code>--simulate all</code>.</p>';
  } else {
    container.innerHTML = workers.map((w) => \`
      <div class="worker \${w.status}">
        <div class="row">
          <span class="dot \${w.status}"></span>
          <span class="id">\${w.id}</span>
          <span class="pill">\${w.provider}</span>
          <span class="pill \${w.status === 'ready' ? 'ok' : w.status === 'blocked' ? 'warn' : ''}">\${w.status}</span>
          <span class="muted">\${w.location}</span>
        </div>
        <div class="caps">\${(w.capabilities || []).join(' · ') || 'no capabilities'}</div>
        <div class="caps">\${w.title || ''} \${w.url ? '· ' + w.url : ''}</div>
        <div class="caps">tasks: \${w.tasks.total} · completed \${w.tasks.completed} · failed \${w.tasks.failed}\${w.tasks.current ? ' · running ' + w.tasks.current : ''}</div>
        <div class="stream" id="stream-\${w.id}">\${w.lastError ? 'last error: ' + w.lastError : ''}</div>
      </div>\`).join('');
  }
  const select = $('worker-select');
  const previous = select.value;
  select.innerHTML = workers.map((w) => \`<option value="\${w.id}">\${w.id} — \${w.status}</option>\`).join('');
  if (previous && workers.some((w) => w.id === previous)) select.value = previous;
  $('worker-pill').textContent = 'workers: ' + workers.length;
}

async function refresh() {
  const [workers, plugins, health] = await Promise.all([
    fetch('/api/workers').then((r) => r.json()),
    fetch('/api/plugins').then((r) => r.json()),
    fetch('/api/health').then((r) => r.json()),
  ]);
  renderWorkers(workers);
  $('plugin-pill').textContent = 'plugins: ' + plugins.length;
  const e = health.extension;
  $('ext-pill').textContent = 'extension: ' + (e.connected ? e.connected + ' connected (:' + e.port + ')' : 'not connected');
  $('ext-pill').className = 'pill ' + (e.connected ? 'ok' : 'warn');
  $('plugins').innerHTML = '<tbody>' + plugins.map((p) => \`<tr>
      <td><code>\${p.id}</code><div class="muted">\${p.name} v\${p.version}</div></td>
      <td class="muted">\${(p.matchPatterns || []).join('<br>')}</td>
      <td class="muted">\${(p.capabilities || []).join(', ')}</td>
      <td><span class="pill">\${p.source}</span></td>
    </tr>\`).join('') + '</tbody>';
}

const es = new EventSource('/api/events');
for (const [event, handler] of Object.entries({
  hello: (data) => renderWorkers(data.workers || []),
  worker: () => refresh(),
  'worker.removed': () => refresh(),
  'task.started': (data) => { log('task started ' + data.workerId + ' ' + data.taskId); const s = $('stream-' + data.workerId); if (s) s.textContent = ''; },
  'task.progress': (data) => { const s = $('stream-' + data.workerId); if (s) s.textContent = data.text.slice(-1200); },
  'task.completed': (data) => { log('task completed ' + data.workerId + ' in ' + data.durationMs + 'ms'); $('answer').textContent = data.response; },
  'task.failed': (data) => log('task failed ' + data.workerId + ': ' + data.error.message),
})) {
  es.addEventListener(event, (e) => { try { handler(JSON.parse(e.data)); } catch {} });
}

$('chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const worker = $('worker-select').value;
  const message = $('message').value;
  if (!worker || !message) return;
  $('send').disabled = true;
  $('answer').textContent = '…';
  log('send_message → ' + worker);
  try {
    const response = await fetch('/api/send_message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker, message }),
    });
    const data = await response.json();
    $('answer').textContent = data.response ? data.response : JSON.stringify(data, null, 2);
    log('answered by ' + worker + ' in ' + data.durationMs + 'ms');
  } catch (error) {
    $('answer').textContent = 'error: ' + error.message;
  } finally {
    $('send').disabled = false;
  }
});

$('snapshot').addEventListener('click', async () => {
  const worker = $('worker-select').value;
  const snapshot = await fetch('/api/snapshot', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker, transcript: false }),
  }).then((r) => r.json());
  $('snap').textContent = JSON.stringify({ url: snapshot.url, provider: snapshot.provider, state: snapshot.state,
    status: snapshot.status, capabilities: snapshot.capabilities, availableActions: snapshot.availableActions }, null, 2);
});
$('newchat').addEventListener('click', async () => {
  await fetch('/api/new_chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker: $('worker-select').value }) });
  log('new chat');
});
$('stop').addEventListener('click', async () => {
  await fetch('/api/stop_worker', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker: $('worker-select').value }) });
  log('stop requested');
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
