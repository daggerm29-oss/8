// Helix Workbench v0 (F-UI-1). Plain ES module, no build step: talks JSON-RPC 2.0 to the Engine over the
// same-origin WebSocket (§22.2). All engine data is rendered with textContent — never innerHTML.

const TOPICS = ['task.*', 'agent.*', 'tool.*', 'model.*', 'verify.*', 'approval.*', 'ledger.*', 'budget.*', 'context.*', 'artifact.*', 'checkpoint.*'];
const TERMINAL = ['done', 'failed', 'cancelled'];
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/* ---------------- token ---------------- */
function takeToken() {
  const m = location.hash.match(/token=([A-Za-z0-9_\-.]+)/);
  if (m) {
    sessionStorage.setItem('helix.token', m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem('helix.token') ?? '';
}

/* ---------------- RPC client ---------------- */
class Rpc {
  constructor() { this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); this.ws = null; this.ready = null; }
  connect(token) {
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
      this.ws = ws;
      ws.onmessage = (e) => this.receive(String(e.data));
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        reject(new Error('connection closed'));
        this.onclose?.();
      };
      ws.onopen = async () => {
        try {
          const init = await this.call('initialize', { clientName: 'helix-workbench', clientVersion: '0.1.0', protocolVersion: '0.1.0', token: token || undefined, topics: TOPICS });
          resolve(init);
        } catch (err) { reject(err); }
      };
    });
    return this.ready;
  }
  receive(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'event') {
      for (const l of this.listeners) l(msg.params);
    }
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
}

/* ---------------- state ---------------- */
const rpc = new Rpc();
const state = { tasks: [], selected: null, tab: 'activity', events: new Map(), stream: '' };

/* ---------------- formatting ---------------- */
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtNum = (n) => (n ?? 0).toLocaleString();
const fmtUsd = (n) => `$${(n ?? 0).toFixed(4)}`;
const short = (s, n = 160) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? `${t.slice(0, n)}…` : t ?? ''; };

function describeEvent(e) {
  const d = e.data ?? {};
  switch (e.topic) {
    case 'task.created': return [`Task created · ${d.provider}/${d.model}`];
    case 'task.status': return [`Status → ${d.status}${d.error ? ` · ${d.error}` : ''}`, TERMINAL.includes(d.status) ? (d.status === 'done' ? 'ok' : 'err') : ''];
    case 'task.step': return [`Step ${d.index + 1} · ${d.kind}`];
    case 'task.backoff': return [`Backoff ${Math.round(d.delayMs / 1000)}s after ${d.kind}`, 'err'];
    case 'task.resumed': return ['Resumed after engine restart'];
    case 'agent.message': return [`${d.text ? short(d.text, 400) : '(no text)'}${d.toolCalls?.length ? `  → ${d.toolCalls.join(', ')}` : ''}`];
    case 'tool.result': return [`${d.tool} · ${d.verdict}${d.isError ? ' · error' : ''} · ${d.durationMs ?? 0}ms${d.summary ? ` — ${short(d.summary)}` : ''}`, d.verdict === 'deny' ? 'deny' : d.isError ? 'err' : ''];
    case 'approval.requested': return [`Approval needed: ${d.tool} ${short(d.args)}`, 'err'];
    case 'verify.gate': return [`Gate ${d.gate} (${d.required ? 'required' : 'optional'}) attempt ${d.attempt}: ${d.passed ? 'passed' : `failed exit ${d.exitCode}`}`, d.passed ? 'ok' : 'err'];
    case 'verify.result': return [`Verification ${d.passed ? 'passed' : 'failed'} (attempt ${d.attempt})`, d.passed ? 'ok' : 'err'];
    case 'context.composed': return [`Context composed${d.tokens ? ` · ${fmtNum(d.tokens)} tokens` : ''}`];
    case 'artifact.created': return [`Artifact: ${d.kind} — ${d.title}`];
    case 'checkpoint.restored': return [`Restored ${d.restored?.length ?? 0} file(s), deleted ${d.deleted?.length ?? 0}`, 'ok'];
    case 'ledger.entry': return [`Model call · ${fmtNum(d.inputTokens)} in / ${fmtNum(d.outputTokens)} out · ${fmtUsd(d.costUsd)}`];
    default: return [short(d)];
  }
}

/* ---------------- rendering ---------------- */
function renderTasks() {
  const list = $('task-list');
  list.replaceChildren(...state.tasks.map((t) => h('li', {},
    h('button', { type: 'button', 'aria-current': state.selected === t.id ? 'true' : 'false', onclick: () => select(t.id) },
      h('span', { class: 't' }, t.title || t.goal),
      h('span', { class: 'm' }, h('span', { class: `badge ${t.status}` }, t.status), h('span', {}, `${t.stepCount} steps`), h('span', {}, t.model))))));
  if (!state.tasks.length) list.append(h('li', { class: 'note' }, 'No tasks yet.'));
}

function renderHead(t) {
  $('task-title').textContent = t.title || t.goal;
  $('task-meta').textContent = `${t.id} · ${t.workspacePath} · ${t.provider}/${t.model}`;
  const badge = $('task-status');
  badge.textContent = t.status;
  badge.className = `badge ${t.status}`;
  $('cancel').disabled = TERMINAL.includes(t.status);
  $('resume').disabled = !['failed', 'cancelled', 'blocked'].includes(t.status);
  const l = t.ledger ?? {};
  const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  $('stats').replaceChildren(
    stat('Steps', fmtNum(t.stepCount)), stat('Model calls', fmtNum(l.calls)), stat('Input tokens', fmtNum(l.inputTokens)),
    stat('Cached', fmtNum(l.cachedInputTokens)), stat('Output tokens', fmtNum(l.outputTokens)), stat('Cost', fmtUsd(l.costUsd)), stat('Verify attempts', fmtNum(t.verifyAttempts)),
  );
  if (t.result || t.error) $('stats').append(h('div', { class: 'stat wide' }, h('div', { class: 'k' }, t.error ? 'Error' : 'Result'), h('div', { class: 'v text' }, t.error ?? t.result)));
}

function activityRow(e) {
  const [text, cls] = describeEvent(e);
  return h('li', {}, h('span', { class: 'time' }, fmtTime(e.at)), h('span', { class: 'topic' }, e.topic), h('span', { class: `body ${cls ?? ''}` }, text));
}

function renderActivity() {
  const events = (state.events.get(state.selected) ?? []).filter((e) => e.topic !== 'model.delta');
  const ol = $('activity');
  ol.replaceChildren(...events.map(activityRow));
  if (state.stream) ol.append(h('li', {}, h('span', { class: 'time' }, 'live'), h('span', { class: 'topic' }, 'model.delta'), h('span', { class: 'body stream' }, state.stream)));
  if (!events.length && !state.stream) ol.append(h('li', { class: 'note' }, 'No events yet.'));
}

async function renderApprovals() {
  const box = $('approvals');
  if (!state.selected) return box.replaceChildren();
  const list = (await rpc.call('agent.approvals.list', { task: state.selected })).filter((a) => a.status === 'pending');
  box.replaceChildren(...list.map((a) => h('div', { class: 'approval', role: 'alert' },
    h('strong', {}, `Approve ${a.tool}? (${a.actionClass})`),
    h('pre', { class: 'mono' }, JSON.stringify(a.args, null, 2)),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'danger', onclick: () => respond(a.id, false) }, 'Deny'),
      h('button', { type: 'button', class: 'primary', onclick: () => respond(a.id, true) }, 'Approve'),
      a.tool.startsWith('mcp__') ? h('button', { type: 'button', title: 'Approve and stop asking for this MCP tool (saved to mcp.json)', onclick: () => respond(a.id, true, true) }, 'Always allow') : null))));
}

async function respond(approvalId, approved, always = false) {
  await rpc.call('agent.approve', { approvalId, approved, always });
  if (always) loadMcp();
  renderApprovals();
}

async function renderTranscript() {
  const msgs = await rpc.call('task.transcript', { id: state.selected });
  const parts = (m) => m.parts.map((p) => {
    if (p.type === 'text') return h('div', { class: 'part' }, p.text);
    if (p.type === 'tool_call') return h('div', { class: 'part' }, h('strong', {}, `→ ${p.name}`), h('pre', { class: 'mono' }, JSON.stringify(p.args, null, 2)));
    if (p.type === 'tool_result') return h('div', { class: 'part' }, h('strong', { class: p.isError ? 'err' : '' }, `← ${p.name}${p.isError ? ' (error)' : ''}`), h('pre', { class: 'mono' }, p.content));
    if (p.type === 'reasoning') return p.summary ? h('div', { class: 'part muted' }, p.summary) : null;
    return null;
  });
  $('transcript').replaceChildren(...msgs.filter((m) => m.role !== 'system').map((m) => h('div', { class: 'msg' }, h('div', { class: 'role' }, m.role), parts(m))));
  if (!msgs.length) $('transcript').append(h('p', { class: 'note' }, 'Transcript is empty.'));
}

async function renderDiff() {
  const select = $('checkpoint-select');
  const cps = await rpc.call('checkpoint.list', { task: state.selected });
  const prev = select.value;
  select.replaceChildren(h('option', { value: '' }, cps.length ? `Whole task (${cps.length} checkpoints)` : 'No checkpoints'),
    ...cps.map((c) => h('option', { value: c.id }, `#${c.seq + 1} · ${fmtTime(c.at)} · ${c.files.map((f) => f.path).join(', ')}`)));
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  $('restore').disabled = !cps.length;
  const files = cps.length ? await rpc.call('checkpoint.diff', { task: state.selected, checkpoint: select.value || undefined }) : [];
  const box = $('diff');
  box.replaceChildren(...files.map((f) => h('div', { class: 'file' },
    h('div', { class: 'file-head' }, h('span', {}, `${f.path} (${f.status})`), h('span', {}, h('span', { class: 'add' }, `+${f.additions}`), ' ', h('span', { class: 'del' }, `-${f.deletions}`))),
    f.patch ? h('pre', { class: 'patch mono' }, f.patch.split('\n').slice(2).filter((l, i, a) => l || i < a.length - 1).map((l) => h('span', { class: l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '' }, l || ' ')))
      : h('p', { class: 'note pad' }, 'No changes (already restored).'))));
  if (!files.length) box.append(h('p', { class: 'note' }, 'The agent has not modified any files.'));
}

function renderGates() {
  const events = (state.events.get(state.selected) ?? []).filter((e) => e.topic === 'verify.gate' || e.topic === 'verify.result');
  const box = $('gates');
  box.replaceChildren(...events.map((e) => {
    const d = e.data;
    const name = e.topic === 'verify.gate' ? `${d.gate} · ${d.command}` : `Overall result`;
    return h('div', { class: 'gate' },
      h('div', { class: 'top' }, h('strong', { class: 'mono' }, name), h('span', { class: `badge ${d.passed ? 'done' : 'failed'}` }, `${d.passed ? 'passed' : 'failed'} · attempt ${d.attempt}`)),
      d.diagnostics?.length ? h('ul', {}, d.diagnostics.slice(0, 20).map((x) => h('li', {}, `${x.file ?? ''}${x.line ? `:${x.line}` : ''} ${x.severity ?? ''} ${x.message ?? ''}`))) : null);
  }));
  if (!events.length) box.append(h('p', { class: 'note' }, 'No verification gates have run for this task.'));
}

async function renderImpact(target) {
  const t = state.tasks.find((x) => x.id === state.selected);
  const box = $('impact');
  box.replaceChildren(h('p', { class: 'note' }, 'Analyzing…'));
  try {
    const r = await rpc.call('index.impact', { workspacePath: t.workspacePath, target });
    box.replaceChildren(
      h('p', { class: 'note' }, `${r.kind} · ${r.definitions.length} definition(s) · ${r.callers.length} caller(s) · precision: ${r.precision}`),
      h('h2', { class: 'section-title' }, 'Callers'),
      r.callers.length ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Depth'), h('th', {}, 'Caller'), h('th', {}, 'Calls'), h('th', {}, 'Location'))),
        h('tbody', {}, r.callers.map((c) => h('tr', {}, h('td', {}, c.depth), h('td', { class: 'mono' }, c.caller || '(module)'), h('td', { class: 'mono' }, c.calls), h('td', { class: 'mono' }, `${c.path}:${c.line}`))))) : h('p', { class: 'note' }, 'None found.'),
      h('h2', { class: 'section-title' }, 'Affected files'), h('ul', { class: 'mono' }, r.affectedFiles.map((f) => h('li', {}, f))),
      h('h2', { class: 'section-title' }, 'Covering tests'), h('ul', { class: 'mono' }, r.tests.map((f) => h('li', {}, f))),
    );
  } catch (err) { box.replaceChildren(h('p', { class: 'form-error' }, err.message)); }
}

async function renderArtifacts() {
  const arts = await rpc.call('artifact.list', { task: state.selected });
  $('artifacts').replaceChildren(...arts.map((a) => h('div', { class: 'msg' }, h('div', { class: 'role' }, `${a.kind} · ${a.title}`), h('div', { class: 'part' }, h('pre', { class: 'mono' }, typeof a.data === 'string' ? a.data : JSON.stringify(a.data, null, 2))))));
  if (!arts.length) $('artifacts').append(h('p', { class: 'note' }, 'No artifacts.'));
}

async function renderTab() {
  if (!state.selected) return;
  try {
    if (state.tab === 'activity') renderActivity();
    else if (state.tab === 'transcript') await renderTranscript();
    else if (state.tab === 'diff') await renderDiff();
    else if (state.tab === 'gates') renderGates();
    else if (state.tab === 'artifacts') await renderArtifacts();
  } catch (err) { console.error('[helix] render failed', err); }
}

/* ---------------- actions ---------------- */
async function refreshTasks() {
  state.tasks = await rpc.call('task.list', { limit: 100 });
  renderTasks();
  if (state.selected) {
    const t = await rpc.call('task.get', { id: state.selected });
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t;
    renderHead(t);
  }
}

async function loadHistory(task) {
  const events = [];
  let after = 0;
  for (;;) {
    const batch = await rpc.call('events.replay', { ws: task.workspaceId, afterSeq: after, limit: 1000 });
    events.push(...batch.filter((e) => e.task === task.id));
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].seq;
  }
  state.events.set(task.id, events);
}

async function select(id) {
  state.selected = id;
  state.stream = '';
  const t = await rpc.call('task.get', { id });
  await loadHistory(t);
  $('empty').hidden = true;
  $('task-view').hidden = false;
  $('impact').replaceChildren();
  renderTasks();
  renderHead(t);
  renderApprovals();
  renderTab();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTasks().catch(() => {}); if (state.tab !== 'activity' && state.tab !== 'impact') renderTab(); }, 250);
}

function onEvent(e) {
  if (!e.task) return;
  if (e.topic === 'model.delta') {
    if (e.task === state.selected) { state.stream += e.data?.text ?? ''; if (state.tab === 'activity') renderActivity(); }
    return;
  }
  const list = state.events.get(e.task) ?? [];
  if (!list.some((x) => x.id === e.id)) list.push(e);
  state.events.set(e.task, list);
  if (e.topic === 'agent.message') state.stream = '';
  if (e.task === state.selected) {
    if (state.tab === 'activity') renderActivity();
    if (state.tab === 'gates' && e.topic.startsWith('verify.')) renderGates();
    if (e.topic.startsWith('approval.') || e.topic === 'task.status') renderApprovals();
  }
  if (['task.created', 'task.status', 'task.step', 'ledger.entry', 'checkpoint.restored', 'tool.result'].includes(e.topic)) scheduleRefresh();
}

function setStatus(text, ok) {
  const el = $('engine-status');
  el.textContent = text;
  el.className = `engine ${ok ? 'ok' : 'bad'}`;
}

function bindUi() {
  $('refresh').addEventListener('click', () => refreshTasks());
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== state.tab;
      renderTab();
    });
  }
  $('new-task').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const params = { workspacePath: String(f.get('workspacePath')).trim(), goal: String(f.get('goal')).trim(), policyProfile: f.get('policyProfile'), start: true };
    if (f.get('model')) params.model = String(f.get('model')).trim();
    if (f.get('verifyCommand')) params.verifyCommand = String(f.get('verifyCommand')).trim();
    if (f.get('budgetUsd')) params.budgetUsd = Number(f.get('budgetUsd'));
    $('form-error').textContent = '';
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const t = await rpc.call('task.create', params);
      form.querySelector('textarea').value = '';
      await refreshTasks();
      await select(t.id);
      loadWorkspaces();
    } catch (err) { $('form-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $('cancel').addEventListener('click', () => rpc.call('task.cancel', { id: state.selected }).then(refreshTasks));
  $('resume').addEventListener('click', () => rpc.call('task.resume', { id: state.selected }).then(refreshTasks).catch((e) => alert(e.message)));
  $('checkpoint-select').addEventListener('change', () => renderDiff());
  $('restore').addEventListener('click', async () => {
    const cp = $('checkpoint-select').value || undefined;
    if (!confirm(cp ? 'Restore files to their state before this checkpoint? The current content is saved first, so this is undoable.' : 'Undo every change this task made? The current content is saved first.')) return;
    try { await rpc.call('checkpoint.restore', { task: state.selected, checkpoint: cp }); await renderDiff(); }
    catch (err) { alert(err.message); }
  });
  $('impact-form').addEventListener('submit', (ev) => { ev.preventDefault(); renderImpact(String(new FormData(ev.currentTarget).get('target')).trim()); });
  $('token-form').addEventListener('submit', () => {
    sessionStorage.setItem('helix.token', String(new FormData($('token-form')).get('token')).trim());
    start();
  });
}

async function loadWorkspaces() {
  const ws = await rpc.call('workspace.list');
  $('workspaces').replaceChildren(...ws.map((w) => h('option', { value: w.path })));
  const input = document.querySelector('input[name="workspacePath"]');
  if (!input.value && ws[0]) input.value = ws[0].path;
}

async function loadMcp() {
  const servers = await rpc.call('mcp.list').catch(() => []);
  const list = $('mcp-list');
  if (!servers.length) {
    list.replaceChildren(h('li', { class: 'note' }, 'No servers. Add them to $HELIX_HOME/mcp.json.'));
    return;
  }
  list.replaceChildren(...servers.map((s) => h('li', { class: 'mcp' },
    h('div', { class: 'm' }, h('span', { class: `badge ${s.state === 'connected' ? 'done' : s.state === 'failed' ? 'failed' : ''}` }, s.state), h('span', { class: 't' }, s.name), h('span', {}, `${s.transport === 'http' ? 'http · ' : ''}${s.tools.length} tools`)),
    s.error ? h('div', { class: 'note err' }, s.error) : null,
    s.tools.length ? h('div', { class: 'tools mono' }, s.tools.map((t) => `${t.name}${t.actionClass === 'read' ? ' (read)' : ''}${t.alwaysAllow ? ' (always)' : ''}`).join(', ')) : null,
    s.filtered?.length ? h('div', { class: 'note' }, `filtered out: ${s.filtered.join(', ')}`) : null)));
}

let retry = 0;
async function start() {
  const cfg = await fetch('/config.json').then((r) => r.json()).catch(() => ({ auth: 'token' }));
  const token = takeToken();
  if (cfg.auth === 'token' && !token) { $('token-dialog').showModal(); setStatus('token required', false); return; }
  rpc.onclose = () => {
    setStatus('disconnected — retrying', false);
    setTimeout(start, Math.min(10000, 500 * 2 ** retry++));
  };
  try {
    const init = await rpc.connect(token);
    retry = 0;
    setStatus(`engine ${init.engineVersion} · ${init.capabilities.sandboxProviders.join(',')} · ${init.capabilities.providers.join(', ')}`, true);
    await refreshTasks();
    await loadWorkspaces();
    loadMcp();
    if (state.selected) await select(state.selected);
  } catch (err) {
    if (/token/i.test(err.message)) {
      sessionStorage.removeItem('helix.token');
      rpc.onclose = null;
      $('token-dialog').showModal();
      setStatus('invalid token', false);
    }
  }
}

rpc.listeners.add(onEvent);
bindUi();
start();
