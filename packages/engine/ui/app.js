// Helix Workbench v0 (F-UI-1). Plain ES module, no build step: talks JSON-RPC 2.0 to the Engine over the
// same-origin WebSocket (§22.2). All engine data is rendered with textContent — never innerHTML.

const TOPICS = ['task.*', 'agent.*', 'tool.*', 'model.*', 'verify.*', 'approval.*', 'ledger.*', 'budget.*', 'context.*', 'artifact.*', 'checkpoint.*', 'preview.*'];
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
    } else if (msg.method === 'terminal.output') {
      this.onTerminal?.(msg.params);
    } else if (msg.method === 'pty.output' || msg.method === 'pty.exit') {
      this.onPty?.(msg.method, msg.params);
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
    case 'verify.baseline': return [d.skipped ? `Baseline skipped · ${d.skipped}` : `Baseline · ${(d.gates ?? []).map((g) => `${g.name} ${g.passed ? 'passed' : `failed (${g.diagnostics})`}`).join(', ')}`];
    case 'verify.result': return [`Verification ${d.passed ? 'passed' : 'failed'} (attempt ${d.attempt})`, d.passed ? 'ok' : 'err'];
    case 'context.composed': return [`Context composed${d.tokens ? ` · ${fmtNum(d.tokens)} tokens` : ''}`];
    case 'artifact.created': return [`Artifact: ${d.kind} — ${d.title}`];
    case 'checkpoint.restored': return [`Restored ${d.restored?.length ?? 0} file(s), deleted ${d.deleted?.length ?? 0}`, 'ok'];
    case 'model.fallback': return [`Model fallback (${d.role}) ${d.from} → ${d.to} · ${d.kind}${d.sticky ? ' · skipped for rest of task' : ''}`, 'err'];
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
  const events = (state.events.get(state.selected) ?? []).filter((e) => ['verify.gate', 'verify.result', 'verify.baseline'].includes(e.topic));
  const box = $('gates');
  const meta = (...items) => { const kept = items.filter(Boolean); return kept.length ? h('div', { class: 'meta' }, kept) : null; };
  const item = (k, v) => h('span', {}, `${k}: `, h('span', { class: 'mono' }, v));
  box.replaceChildren(...events.map((e) => {
    const d = e.data;
    if (e.topic === 'verify.baseline') {
      return h('div', { class: 'gate' },
        h('div', { class: 'top' }, h('strong', {}, 'Baseline (before any edits)'), h('span', { class: 'badge' }, d.skipped ? 'skipped' : `${d.gates?.length ?? 0} gate(s)`)),
        d.skipped ? h('p', { class: 'note pad' }, d.skipped) : meta(...(d.gates ?? []).map((g) => item(g.name, g.passed ? 'passed' : `failed · ${g.diagnostics} diagnostic(s)`))));
    }
    const name = e.topic === 'verify.gate' ? `${d.gate} · ${d.command}` : 'Overall result';
    const tolerated = e.topic === 'verify.result' ? (d.gates ?? []).filter((g) => g.preexistingOnly).map((g) => g.name) : [];
    return h('div', { class: 'gate' },
      h('div', { class: 'top' }, h('strong', { class: 'mono' }, name), h('span', { class: `badge ${d.passed ? 'done' : 'failed'}` }, `${d.passed ? 'passed' : 'failed'} · attempt ${d.attempt}`)),
      meta(
        d.selectedTests ? item('Selected tests', d.selectedTests.length ? d.selectedTests.join(', ') : 'none (fallback)') : null,
        d.changedFiles?.length ? item('Changed files', d.changedFiles.join(', ')) : null,
        d.preexisting !== undefined ? item('Diagnostics', `${d.new} new · ${d.preexisting} pre-existing`) : null,
        tolerated.length ? item('Pre-existing only (not blocking)', tolerated.join(', ')) : null,
      ),
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

/* ---------------- model roles (F-MDL-4) ---------------- */
const ROLE_NAMES = ['planner', 'coder', 'explorer', 'reviewer', 'debugger', 'summarizer', 'embedder', 'completion', 'router'];
const refStr = (r) => `${r.provider}/${r.model}`;

/** Same syntax as CLI `--role`: one `role=provider/model[,fallback…]` per line. */
function parseRolesText(text) {
  const roles = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`line ${i + 1}: expected role=provider/model`);
    const role = line.slice(0, eq).trim();
    if (!ROLE_NAMES.includes(role)) throw new Error(`line ${i + 1}: unknown role '${role}' (known: ${ROLE_NAMES.join(', ')})`);
    if (roles[role]) throw new Error(`line ${i + 1}: role '${role}' given twice`);
    const [primary, ...fallbacks] = line.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!primary) throw new Error(`line ${i + 1}: ${role}= needs a model`);
    roles[role] = { primary, fallbacks };
  }
  return roles;
}

function formParams(form) {
  const f = new FormData(form);
  const params = { workspacePath: String(f.get('workspacePath')).trim(), goal: String(f.get('goal')).trim(), policyProfile: f.get('policyProfile'), start: true };
  if (f.get('model')) params.model = String(f.get('model')).trim();
  if (f.get('verifyCommand')) params.verifyCommand = String(f.get('verifyCommand')).trim();
  if (f.get('budgetUsd')) params.budgetUsd = Number(f.get('budgetUsd'));
  const roles = parseRolesText(String(f.get('roles') ?? ''));
  if (Object.keys(roles).length) params.roles = roles;
  return params;
}

const rolePreview = { timer: null, seq: 0, error: '' };
function schedulePreview() {
  clearTimeout(rolePreview.timer);
  rolePreview.timer = setTimeout(() => previewRoles().catch(() => {}), 300);
}

async function previewRoles() {
  const form = $('new-task');
  const box = $('roles-preview');
  const seq = ++rolePreview.seq;
  let params;
  try { params = formParams(form); }
  catch (err) { rolePreview.error = err.message; box.replaceChildren(h('p', { class: 'form-error' }, err.message)); $('roles-summary').textContent = '(invalid)'; return; }
  const n = Object.keys(params.roles ?? {}).length;
  $('roles-summary').textContent = n ? `(${n} override${n > 1 ? 's' : ''})` : '(defaults)';
  if (!$('roles-picker').open || !params.workspacePath) { rolePreview.error = ''; box.replaceChildren(); return; }
  try {
    const roles = await rpc.call('models.roles', { workspacePath: params.workspacePath, model: params.model, roles: params.roles, policyProfile: params.policyProfile });
    if (seq !== rolePreview.seq) return;
    rolePreview.error = '';
    const all = ROLE_NAMES.map((r) => roles[r]).filter(Boolean);
    const inherits = (b) => b.role !== 'coder' && b.source === 'default' && !b.dropped.length;
    const shown = all.filter((b) => !inherits(b));
    const rest = all.filter(inherits).map((b) => b.role);
    box.replaceChildren(h('div', { class: 'note' }, 'Resolved (task > workspace > user; org policy last):'), ...shown.map((b) => h('div', { class: `r${b.source === 'default' ? '' : ' changed'}` },
      h('span', { class: 'k mono' }, b.role),
      h('span', { class: 'mono' }, b.chain.length ? b.chain.map(refStr).join(' → ') : 'none allowed'),
      h('span', { class: 'src' }, b.source),
      ...b.dropped.map((d) => h('span', { class: 'drop', title: d.reason }, `dropped ${d.ref}`)))),
      rest.length ? h('div', { class: 'src' }, `Inherit coder: ${rest.join(', ')}`) : null);
  } catch (err) {
    if (seq !== rolePreview.seq) return;
    rolePreview.error = err.message;
    box.replaceChildren(h('p', { class: 'form-error' }, err.message));
  }
}

async function renderRoles() {
  const box = $('roles');
  const r = await rpc.call('models.usage', { task: state.selected });
  const used = new Map();
  for (const u of r.usage) { if (!used.has(u.role)) used.set(u.role, []); used.get(u.role).push(u); }
  const rows = ROLE_NAMES.map((role) => ({ role, b: r.bindings?.[role], u: used.get(role) ?? [] })).filter((x) => x.u.length || (x.b && x.b.source !== 'default') || x.role === 'coder');
  const table = h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }, 'Configured chain'), h('th', { scope: 'col' }, 'Source'), h('th', { scope: 'col' }, 'Actually used'), h('th', { scope: 'col' }, 'Calls'), h('th', { scope: 'col' }, 'Tokens in / out'), h('th', { scope: 'col' }, 'Cost'))),
    h('tbody', {}, rows.flatMap(({ role, b, u }) => {
      const cfg = b ? (b.chain.length ? b.chain.map(refStr).join(' → ') : 'none allowed') : '—';
      const src = b ? (b.source === 'default' && role !== 'coder' ? 'inherits coder' : b.source) : '—';
      if (!u.length) return [h('tr', {}, h('td', { class: 'mono' }, role), h('td', { class: 'mono' }, cfg), h('td', {}, src), h('td', { class: 'note' }, 'not used yet'), h('td', {}, '0'), h('td', {}, '—'), h('td', {}, '—'))];
      return u.map((x, i) => h('tr', {},
        h('td', { class: 'mono' }, i ? '' : role), h('td', { class: 'mono' }, i ? '' : cfg), h('td', {}, i ? '' : src),
        h('td', { class: 'mono' }, `${x.provider}/${x.model}`, b && b.chain[0] && refStr(b.chain[0]) !== `${x.provider}/${x.model}` ? h('span', { class: 'sub' }, 'fallback') : null),
        h('td', { class: 'mono' }, String(x.calls), x.failed ? h('span', { class: 'sub err' }, `${x.failed} failed`) : null),
        h('td', { class: 'mono' }, `${fmtNum(x.inputTokens)} / ${fmtNum(x.outputTokens)}`), h('td', { class: 'mono' }, fmtUsd(x.costUsd))));
    })));
  box.replaceChildren(
    h('p', { class: 'note' }, 'Configured bindings were fixed when the task was created. "Actually used" comes from the token ledger.'),
    table,
    h('h2', { class: 'section-title' }, `Fallbacks (${r.fallbacks.length})`),
    r.fallbacks.length ? h('ul', { class: 'mono fallbacks' }, r.fallbacks.map((f) => h('li', {}, `${fmtTime(f.at)} · ${f.role}: ${f.from} → ${f.to} · ${f.kind}${f.sticky ? ' (skipped for rest of task)' : ''}`))) : h('p', { class: 'note' }, 'No model fallbacks.'),
  );
}

/* ---------------- step / tool-call tree (F-UI-2) ---------------- */
const openSteps = new Set();

async function renderSteps() {
  const box = $('steps');
  const steps = await rpc.call('task.steps', { task: state.selected });
  const dur = (a, b) => (b ? fmtElapsed(Date.parse(b) - Date.parse(a)) : 'running');
  const callCls = (s) => (s === 'ok' ? 'ok' : s === 'pending' ? '' : 'err');
  box.replaceChildren(...steps.map((s) => {
    const d = h('details', { class: 'step', open: openSteps.has(s.id) || s.status === 'running' },
      h('summary', {},
        h('span', { class: 'mono' }, `#${s.index + 1}`),
        h('span', { class: `badge ${s.status === 'done' ? 'done' : s.status === 'error' ? 'failed' : 'running'}` }, s.status),
        h('span', { class: 'grow' }, s.toolCalls.length ? s.toolCalls.map((c) => c.tool).join(', ') : short(s.text, 80) || '(no output)'),
        s.model ? h('span', { class: 'sub mono' }, `${s.model.ref} · ${fmtNum(s.model.inputTokens)} / ${fmtNum(s.model.outputTokens)} · ${fmtUsd(s.model.costUsd)}`) : null,
        h('span', { class: 'sub mono' }, dur(s.startedAt, s.endedAt))),
      s.text ? h('div', { class: 'part' }, s.text) : null,
      s.toolCalls.length ? h('ul', { class: 'calls' }, s.toolCalls.map((c) => h('li', {},
        h('details', {},
          h('summary', {}, h('strong', { class: callCls(c.status) }, c.tool), ` · ${c.status}`, c.durationMs !== null ? ` · ${c.durationMs}ms` : '', c.summary ? h('span', { class: 'sub' }, ` — ${short(c.summary, 120)}`) : null),
          h('pre', { class: 'mono' }, JSON.stringify(c.args, null, 2)))))) : null);
    d.addEventListener('toggle', () => (d.open ? openSteps.add(s.id) : openSteps.delete(s.id)));
    return d;
  }));
  if (!steps.length) box.append(h('p', { class: 'note' }, 'No steps yet.'));
}

/* ---------------- files (F-UI-1) ---------------- */
const files = { ws: null, tree: null, open: null, loaded: null, editing: false };
const selectedWorkspace = () => state.tasks.find((x) => x.id === state.selected)?.workspacePath ?? null;

async function renderFiles(force = false) {
  const ws = selectedWorkspace();
  if (!ws) return;
  if (force || files.ws !== ws || !files.tree) {
    files.ws = ws;
    files.open = null;
    files.loaded = null;
    setEditing(false);
    $('file-name').textContent = 'Select a file';
    $('file-info').textContent = '';
    $('file-content').replaceChildren();
    $('file-list').replaceChildren(h('li', { class: 'note' }, 'Loading…'));
    try { files.tree = await rpc.call('fs.tree', { workspacePath: ws }); }
    catch (err) { $('file-list').replaceChildren(h('li', { class: 'form-error' }, err.message)); return; }
  }
  renderFileList();
}

function renderFileList() {
  const q = $('file-filter').value.trim().toLowerCase();
  const all = files.tree?.files ?? [];
  const matches = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
  const shown = matches.slice(0, 600);
  $('file-list').replaceChildren(...shown.map((f) => {
    const i = f.lastIndexOf('/');
    return h('li', {}, h('button', { type: 'button', title: f, 'aria-current': files.open === f ? 'true' : 'false', onclick: () => openFile(f) },
      i >= 0 ? h('span', { class: 'dir' }, f.slice(0, i + 1)) : null, f.slice(i + 1)));
  }));
  if (!shown.length) $('file-list').append(h('li', { class: 'note' }, q ? 'No matches.' : 'No files.'));
  $('file-count').textContent = `${fmtNum(matches.length)} file(s)${matches.length > shown.length ? `, showing ${shown.length}` : ''}${files.tree?.truncated ? ' · list truncated' : ''}`;
}

const isDirty = () => files.editing && files.loaded && $('file-editor').value !== files.loaded.content;
const confirmDiscard = () => !isDirty() || confirm(`Discard unsaved changes to ${files.loaded.path}?`);

function setEditing(on) {
  files.editing = on;
  const f = files.loaded;
  const editable = !!f && !f.binary && !f.truncated && f.hash !== null;
  $('file-edit').hidden = on || !editable;
  $('file-save').hidden = !on;
  $('file-cancel').hidden = !on;
  $('file-content').hidden = on;
  $('file-editor').hidden = !on;
  if (on) {
    $('file-editor').value = f.content;
    $('file-editor').focus();
  }
}

function showFile(f) {
  files.loaded = f;
  $('file-info').textContent = `${fmtNum(f.size)} bytes${f.truncated ? ' · truncated (read-only)' : ''}`;
  $('file-content').replaceChildren(...(f.binary ? [h('span', { class: 'note' }, 'Binary file not shown.')] : f.content.replace(/\n$/, '').split('\n').map((l) => h('span', { class: 'ln' }, l || ' '))));
  setEditing(false);
}

async function openFile(path) {
  if (!confirmDiscard()) return;
  files.open = path;
  files.loaded = null;
  setEditing(false);
  renderFileList();
  $('file-name').textContent = path;
  $('file-info').textContent = 'loading…';
  try {
    const f = await rpc.call('fs.read', { workspacePath: files.ws, path });
    if (files.open !== path) return;
    showFile(f);
  } catch (err) { $('file-info').textContent = ''; $('file-content').replaceChildren(h('span', { class: 'form-error' }, err.message)); }
}

async function saveFile() {
  const f = files.loaded;
  if (!f || !files.editing) return;
  const content = $('file-editor').value;
  $('file-save').disabled = true;
  $('file-info').textContent = 'saving…';
  try {
    const r = await rpc.call('fs.write', { workspacePath: files.ws, path: f.path, content, baseHash: f.hash });
    showFile({ ...f, content, size: r.size, hash: r.hash });
    $('file-info').textContent = `Saved · ${fmtNum(r.size)} bytes`;
  } catch (err) {
    $('file-info').textContent = err.message.includes('changed on disk') ? 'Conflict: file changed on disk. Copy your edits, then Cancel to reload.' : `Save failed: ${err.message}`;
  } finally { $('file-save').disabled = false; }
}

/* ---------------- terminal (F-TRM-1 v0) ---------------- */
const term = { buffers: new Map(), runId: null, history: [], cursor: -1 };
const termBuffer = (ws) => { if (!term.buffers.has(ws)) term.buffers.set(ws, []); return term.buffers.get(ws); };
const TERM_MAX_LINES = 4000;

function termAppend(ws, text, cls = '') {
  const buf = termBuffer(ws);
  buf.push({ text, cls });
  if (buf.length > TERM_MAX_LINES) buf.splice(0, buf.length - TERM_MAX_LINES);
  if (state.tab === 'terminal' && selectedWorkspace() === ws) {
    const out = $('term-output');
    const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
    out.append(h('span', { class: cls }, text));
    if (stick) out.scrollTop = out.scrollHeight;
  }
}

function renderTerminal() {
  const ws = selectedWorkspace();
  const out = $('term-output');
  out.replaceChildren(...(ws ? termBuffer(ws) : []).map((c) => h('span', { class: c.cls }, c.text)));
  if (!out.childNodes.length) out.append(h('span', { class: 'exit-ok' }, `Workspace: ${ws ?? '—'}\n`));
  out.scrollTop = out.scrollHeight;
  $('term-kill').disabled = !term.runId;
  $('term-run').disabled = !!term.runId;
  renderShell();
}

async function runCommand(command) {
  const ws = selectedWorkspace();
  if (!ws || !command || term.runId) return;
  if (term.history[term.history.length - 1] !== command) term.history.push(command);
  term.cursor = -1;
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  term.runId = runId;
  term.runWs = ws;
  renderTerminal();
  termAppend(ws, `$ ${command}\n`, 'cmd');
  try {
    const r = await rpc.call('terminal.run', { workspacePath: ws, command, runId });
    const status = r.killed ? 'killed' : r.timedOut ? 'timed out' : `exit ${r.exitCode ?? r.signal}`;
    termAppend(ws, `[${status} · ${r.durationMs} ms${r.truncated ? ' · output truncated' : ''}]\n`, r.exitCode === 0 ? 'exit-ok' : 'exit-bad');
  } catch (err) { termAppend(ws, `[error: ${err.message}]\n`, 'exit-bad'); }
  finally { term.runId = null; if (state.tab === 'terminal') renderTerminal(); }
}

/* Interactive PTY shell (F-TRM-1): one per workspace, xterm.js view, input goes to pty.write. */
const shells = new Map(); // ws -> { ptyId, xterm, el, exited }
const PTY_ROWS = 24;
/* Columns fitted to the panel at open (xterm char width ≈ 0.6 × 13px font); no live resize through `script`. */
const ptyCols = () => Math.max(40, Math.min(200, Math.floor(($('pty-host').parentElement.clientWidth - 24) / 7.9)));

function renderShell() {
  const ws = selectedWorkspace();
  const host = $('pty-host');
  const s = ws ? shells.get(ws) : null;
  host.replaceChildren(...(s ? [s.el] : []));
  host.hidden = !s;
  $('pty-open').hidden = !!(s && !s.exited);
  $('pty-close').hidden = !(s && !s.exited);
  $('pty-open').disabled = !ws || typeof window.Terminal !== 'function';
  $('pty-status').textContent = !ws ? 'Select a task to pick a workspace.' : s ? (s.exited ? `Shell exited (${s.exitCode ?? 'killed'}).` : 'Shell running in the workspace sandbox.') : 'No shell open.';
  if (s && !s.exited) s.xterm.focus();
}

async function openShell() {
  const ws = selectedWorkspace();
  if (!ws) return;
  shells.get(ws)?.xterm.dispose();
  const el = h('div', { class: 'pty-view' });
  const cols = ptyCols();
  const xterm = new window.Terminal({ cols, rows: PTY_ROWS, convertEol: false, cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#0f1115', foreground: '#e6e6e6' } });
  const s = { ptyId: null, xterm, el, exited: false, exitCode: null };
  shells.set(ws, s);
  renderShell();
  xterm.open(el);
  try {
    const r = await rpc.call('pty.open', { workspacePath: ws, cols, rows: PTY_ROWS });
    s.ptyId = r.ptyId;
    xterm.onData((data) => { if (!s.exited) rpc.call('pty.write', { ptyId: s.ptyId, data }).catch(() => {}); });
  } catch (err) {
    xterm.write(`\r\n[error: ${err.message}]\r\n`);
    s.exited = true;
  }
  renderShell();
}

rpc.onPty = (method, p) => {
  const s = [...shells.values()].find((x) => x.ptyId === p.ptyId);
  if (!s) return;
  if (method === 'pty.output') s.xterm.write(p.data);
  else { s.exited = true; s.exitCode = p.exitCode; s.xterm.write(`\r\n[shell exited: ${p.exitCode ?? 'killed'}]\r\n`); if (state.tab === 'terminal') renderShell(); }
};

rpc.onTerminal = (p) => {
  if (p.runId !== term.runId || !term.runWs) return;
  termAppend(term.runWs, p.text, p.stream === 'stderr' ? 'stderr' : '');
};

/* ---------------- preview (F-PRV-2) ---------------- */
const preview = { byWs: new Map(), busy: false, error: '' };

function renderPreview() {
  const ws = selectedWorkspace();
  const info = ws ? preview.byWs.get(ws) : null;
  const frame = $('preview-frame');
  $('preview-status').textContent = preview.busy ? 'Starting dev server…' : preview.error ? preview.error : info ? `${info.command} → ${info.url}` : 'No dev server running.';
  $('preview-start').hidden = !!info;
  $('preview-start').disabled = preview.busy || !ws;
  $('preview-reload').hidden = !info;
  $('preview-open').hidden = !info;
  frame.hidden = !info;
  if (info) {
    $('preview-open').href = info.url;
    if (frame.dataset.url !== info.url) { frame.dataset.url = info.url; frame.src = info.url; }
  }
}

async function startPreview() {
  const ws = selectedWorkspace();
  if (!ws || preview.busy) return;
  preview.busy = true; preview.error = '';
  renderPreview();
  try { preview.byWs.set(ws, await rpc.call('preview.start', { workspacePath: ws }, 120_000)); }
  catch (err) { preview.error = `Failed: ${String(err.message ?? err).split('\n')[0]}`; }
  finally { preview.busy = false; if (state.tab === 'preview') renderPreview(); }
}

function reloadPreview() {
  const frame = $('preview-frame');
  if (frame.dataset.url) frame.src = frame.dataset.url;
}

async function renderTab() {
  if (!state.selected) return;
  try {
    if (state.tab === 'activity') renderActivity();
    else if (state.tab === 'steps') await renderSteps();
    else if (state.tab === 'transcript') await renderTranscript();
    else if (state.tab === 'diff') await renderDiff();
    else if (state.tab === 'gates') renderGates();
    else if (state.tab === 'roles') await renderRoles();
    else if (state.tab === 'artifacts') await renderArtifacts();
    else if (state.tab === 'files') await renderFiles();
    else if (state.tab === 'terminal') renderTerminal();
    else if (state.tab === 'preview') renderPreview();
  } catch (err) { console.error('[helix] render failed', err); }
}

/* ---------------- activity monitor (F-UI-2) ---------------- */
const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const ago = (iso) => `${fmtElapsed(Math.max(0, Date.now() - Date.parse(iso)))} ago`;
const monitor = { rows: [], fetchedAt: 0, checked: new Set() };

async function loadMonitor() {
  monitor.rows = await rpc.call('task.monitor', { limit: 100 });
  monitor.fetchedAt = Date.now();
  const pending = new Set(monitor.rows.flatMap((r) => r.pendingApprovals.map((a) => a.id)));
  for (const id of monitor.checked) if (!pending.has(id)) monitor.checked.delete(id);
  renderMonitor();
}

function renderMonitor() {
  const rows = monitor.rows;
  const active = rows.filter((r) => !TERMINAL.includes(r.status));
  const approvals = rows.flatMap((r) => r.pendingApprovals.map((a) => ({ ...a, title: r.title || r.goal })));
  const cost = rows.reduce((n, r) => n + (r.ledger?.costUsd ?? 0), 0);
  const tokens = rows.reduce((n, r) => n + (r.ledger?.inputTokens ?? 0) + (r.ledger?.outputTokens ?? 0), 0);
  const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  $('monitor-stats').replaceChildren(stat('Active tasks', fmtNum(active.length)), stat('Awaiting approval', fmtNum(approvals.length)), stat('Total tasks', fmtNum(rows.length)), stat('Tokens', fmtNum(tokens)), stat('Spend', fmtUsd(cost)));

  $('monitor-approvals').hidden = !approvals.length;
  $('monitor-approval-list').replaceChildren(...approvals.map((a) => h('li', {}, h('label', {},
    h('input', { type: 'checkbox', checked: monitor.checked.has(a.id), onchange: (ev) => { ev.currentTarget.checked ? monitor.checked.add(a.id) : monitor.checked.delete(a.id); syncBatchButtons(); } }),
    h('span', {}, h('strong', {}, a.tool), ` (${a.actionClass}) · ${short(a.title, 60)}`, h('span', { class: 'sub mono' }, ` ${short(a.args, 140)}`))))));
  syncBatchButtons();

  const drift = Date.now() - monitor.fetchedAt;
  $('monitor-rows').replaceChildren(...rows.map((r) => {
    const live = !TERMINAL.includes(r.status);
    const l = r.ledger ?? {};
    return h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'task-link', title: r.goal, onclick: () => select(r.id) }, r.title || r.goal), h('span', { class: 'sub' }, `${r.provider}/${r.model}`)),
      h('td', {}, h('span', { class: `badge ${r.status}` }, r.status), r.pendingApprovals.length ? h('span', { class: 'sub' }, `${r.pendingApprovals.length} approval(s)`) : null),
      h('td', { class: live && r.running ? 'live' : '' }, r.currentStep ? `#${r.currentStep.index + 1} ${r.currentStep.kind}` : '—', r.currentStep ? h('span', { class: 'sub' }, r.currentStep.status) : null),
      h('td', { class: 'mono' }, r.lastTool ? r.lastTool.tool : '—', r.lastTool ? h('span', { class: 'sub' }, `${r.lastTool.status} · ${ago(r.lastTool.at)}`) : null),
      h('td', { class: 'mono' }, `${fmtNum(l.inputTokens)} / ${fmtNum(l.outputTokens)}`, h('span', { class: 'sub' }, `${fmtNum(l.calls)} call(s)`)),
      h('td', { class: 'mono' }, fmtUsd(l.costUsd)),
      h('td', { class: 'mono' }, fmtElapsed(r.elapsedMs + (live ? drift : 0))),
      h('td', { class: 'mono' }, String(r.checkpointCount), r.lastCheckpoint ? h('span', { class: 'sub', title: r.lastCheckpoint.files.join(', ') }, short(r.lastCheckpoint.files.join(', '), 40)) : null),
      h('td', {}, h('div', { class: 'actions' },
        live ? h('button', { type: 'button', class: 'danger', 'aria-label': `Cancel ${r.title || r.goal}`, onclick: () => rpc.call('task.cancel', { id: r.id }).then(loadMonitor) }, 'Cancel') : null,
        ['failed', 'cancelled', 'blocked'].includes(r.status) ? h('button', { type: 'button', 'aria-label': `Resume ${r.title || r.goal}`, onclick: () => rpc.call('task.resume', { id: r.id }).then(loadMonitor).catch((e) => alert(e.message)) }, 'Resume') : null)));
  }));
  if (!rows.length) $('monitor-rows').append(h('tr', {}, h('td', { colspan: 9, class: 'note' }, 'No tasks yet. Start one on the left.')));
}

function syncBatchButtons() {
  $('batch-approve').disabled = !monitor.checked.size;
  $('batch-deny').disabled = !monitor.checked.size;
}

async function batchRespond(approved) {
  const ids = [...monitor.checked];
  monitor.checked.clear();
  await Promise.allSettled(ids.map((approvalId) => rpc.call('agent.approve', { approvalId, approved })));
  await loadMonitor();
}

function showMonitor() {
  state.selected = null;
  state.stream = '';
  $('task-view').hidden = true;
  $('monitor-view').hidden = false;
  $('show-monitor').setAttribute('aria-pressed', 'true');
  renderTasks();
  loadMonitor().catch((err) => console.error('[helix] monitor failed', err));
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
  $('monitor-view').hidden = true;
  $('show-monitor').setAttribute('aria-pressed', 'false');
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
  refreshTimer = setTimeout(() => {
    refreshTasks().catch(() => {});
    if (!state.selected) loadMonitor().catch(() => {});
    else if (!['activity', 'impact', 'files', 'terminal'].includes(state.tab)) renderTab();
  }, 250);
}

setInterval(() => {
  if (!state.selected && monitor.rows.length && !document.hidden) renderMonitor();
}, 1000);

function onEvent(e) {
  if (e.topic === 'preview.ready' || e.topic === 'preview.exited') {
    const wsPath = e.data?.workspacePath;
    if (wsPath) e.topic === 'preview.ready' ? preview.byWs.set(wsPath, e.data) : preview.byWs.delete(wsPath);
    if (state.tab === 'preview') renderPreview();
    return;
  }
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
    if (state.tab === 'steps' && ['task.step', 'agent.message', 'tool.result'].includes(e.topic)) renderSteps().catch((err) => console.error('[helix] steps render failed', err));
    if (e.topic.startsWith('approval.') || e.topic === 'task.status') renderApprovals();
  }
  if (['task.created', 'task.status', 'task.step', 'ledger.entry', 'checkpoint.restored', 'tool.result', 'approval.requested', 'approval.resolved'].includes(e.topic)) scheduleRefresh();
}

function setStatus(text, ok) {
  const el = $('engine-status');
  el.textContent = text;
  el.className = `engine ${ok ? 'ok' : 'bad'}`;
}

function bindUi() {
  $('preview-start').addEventListener('click', startPreview);
  $('preview-reload').addEventListener('click', reloadPreview);
  $('refresh').addEventListener('click', () => { refreshTasks(); if (!state.selected) loadMonitor(); });
  $('show-monitor').addEventListener('click', showMonitor);
  $('batch-approve').addEventListener('click', () => batchRespond(true));
  $('batch-deny').addEventListener('click', () => batchRespond(false));
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
    $('form-error').textContent = '';
    let params;
    try { params = formParams(form); }
    catch (err) { $('roles-picker').open = true; $('form-error').textContent = `Roles: ${err.message}`; return; }
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
  for (const name of ['workspacePath', 'model', 'roles', 'policyProfile']) {
    const el = $('new-task').elements.namedItem(name);
    el.addEventListener('input', schedulePreview);
    el.addEventListener('change', schedulePreview);
  }
  $('roles-picker').addEventListener('toggle', schedulePreview);
  $('cancel').addEventListener('click', () => rpc.call('task.cancel', { id: state.selected }).then(refreshTasks));
  $('resume').addEventListener('click', () => rpc.call('task.resume', { id: state.selected }).then(refreshTasks).catch((e) => alert(e.message)));
  $('checkpoint-select').addEventListener('change', () => renderDiff());
  $('restore').addEventListener('click', async () => {
    const cp = $('checkpoint-select').value || undefined;
    if (!confirm(cp ? 'Restore files to their state before this checkpoint? The current content is saved first, so this is undoable.' : 'Undo every change this task made? The current content is saved first.')) return;
    try { await rpc.call('checkpoint.restore', { task: state.selected, checkpoint: cp }); await renderDiff(); }
    catch (err) { alert(err.message); }
  });
  $('file-filter').addEventListener('input', () => renderFileList());
  $('file-edit').addEventListener('click', () => setEditing(true));
  $('file-save').addEventListener('click', () => saveFile());
  $('file-cancel').addEventListener('click', () => { if (confirmDiscard() && files.open) { files.editing = false; openFile(files.open); } });
  $('file-editor').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveFile(); }
    else if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      ev.currentTarget.setRangeText('  ', ev.currentTarget.selectionStart, ev.currentTarget.selectionEnd, 'end');
    }
  });
  window.addEventListener('beforeunload', (ev) => { if (isDirty()) ev.preventDefault(); });
  $('term-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('term-input');
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    runCommand(cmd);
  });
  $('term-input').addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    if (!term.history.length) return;
    ev.preventDefault();
    if (ev.key === 'ArrowUp') term.cursor = term.cursor < 0 ? term.history.length - 1 : Math.max(0, term.cursor - 1);
    else term.cursor = term.cursor < 0 ? -1 : term.cursor + 1 >= term.history.length ? -1 : term.cursor + 1;
    ev.currentTarget.value = term.cursor < 0 ? '' : term.history[term.cursor];
  });
  $('term-kill').addEventListener('click', () => { if (term.runId) rpc.call('terminal.kill', { runId: term.runId }); });
  $('pty-open').addEventListener('click', () => openShell());
  $('pty-close').addEventListener('click', () => { const s = shells.get(selectedWorkspace()); if (s?.ptyId) rpc.call('pty.kill', { ptyId: s.ptyId }); });
  $('term-clear').addEventListener('click', () => { const ws = selectedWorkspace(); if (ws) term.buffers.set(ws, []); renderTerminal(); });
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
    else await loadMonitor();
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
