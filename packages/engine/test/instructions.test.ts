import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { assembleContext } from '../src/context/assembler.ts';
import { CONFLICT_RULE, explainInstructions, loadInstructions, parseRule } from '../src/context/instructions.ts';

function repo(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'helix-instr-')));
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  for (const [path, text] of Object.entries({ ...files })) {
    const abs = path.startsWith('~/') ? join(home, path.slice(2)) : join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return { root, home };
}

const rule = (front: string, body: string) => `---\n${front}\n---\n${body}\n`;

test('CLAUDE.md and .cursor/rules/*.mdc are imported next to AGENTS.md and HELIX.md', () => {
  const { root, home } = repo({
    'CLAUDE.md': 'claude: use pnpm',
    'AGENTS.md': 'agents: run node --test',
    'HELIX.md': 'helix: small diffs',
    '.cursor/rules/style.mdc': rule('description: style\nalwaysApply: true', 'cursor: two-space indent'),
    '.cursor/rules/plain.md': 'cursor plain rule without front matter',
    '.cursorrules': 'legacy cursorrules text',
  });
  const ins = loadInstructions(root, { helixHome: home });
  assert.deepEqual(ins.sources.map((s) => s.origin).sort(), ['agents', 'claude', 'cursor', 'cursor', 'cursor', 'helix']);
  for (const needle of ['claude: use pnpm', 'agents: run node --test', 'helix: small diffs', 'cursor: two-space indent', 'cursor plain rule without front matter', 'legacy cursorrules text']) assert.ok(ins.text.includes(needle), needle);
  assert.ok(!ins.text.includes('alwaysApply'), 'front matter is not injected');
  assert.match(ins.text, /<instructions source="CLAUDE.md" origin="claude">/);
  assert.match(ins.text, /<instructions source=".cursor\/rules\/style.mdc" origin="cursor">/);
});

test('precedence is global -> root -> nested, and Helix-native files outrank imports in the same directory', () => {
  const { root, home } = repo({
    '~/HELIX.md': 'GLOBAL',
    'CLAUDE.md': 'ROOT-CLAUDE',
    '.cursor/rules/a.mdc': rule('alwaysApply: true', 'ROOT-CURSOR'),
    'AGENTS.md': 'ROOT-AGENTS',
    'HELIX.md': 'ROOT-HELIX',
    'src/CLAUDE.md': 'NESTED-CLAUDE',
    'src/AGENTS.md': 'NESTED-AGENTS',
    'src/deep/AGENTS.md': 'DEEPER-AGENTS',
  });
  const ins = loadInstructions(root, { helixHome: home, touchedPaths: ['src/deep/x.ts'] });
  const order = ['GLOBAL', 'ROOT-CLAUDE', 'ROOT-CURSOR', 'ROOT-AGENTS', 'ROOT-HELIX', 'NESTED-CLAUDE', 'NESTED-AGENTS', 'DEEPER-AGENTS'];
  assert.deepEqual(order.map((o) => ins.text.indexOf(o)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1])), true, ins.text);
  assert.deepEqual(ins.sources.map((s) => s.scope), ['user', 'repo', 'repo', 'repo', 'repo', 'nested', 'nested', 'nested']);
  assert.deepEqual(ins.sources.map((s) => s.rank), [...ins.sources.map((s) => s.rank)].sort((a, b) => a - b));
});

test('Cursor scoping: globs apply only when a path being edited matches; description-only rules stay out of the static prompt', () => {
  const { root } = repo({
    '.cursor/rules/ts.mdc': rule('description: TS\nglobs: src/**/*.ts, lib/**\nalwaysApply: false', 'TS-RULE'),
    '.cursor/rules/list.mdc': rule('globs:\n  - "docs/**/*.md"\nalwaysApply: false', 'DOCS-RULE'),
    '.cursor/rules/ask.mdc': rule('description: when writing migrations\nalwaysApply: false', 'AGENT-REQUESTED-RULE'),
  });
  const none = loadInstructions(root, { touchedPaths: ['README.md'] });
  assert.equal(none.text, '');
  const ts = loadInstructions(root, { touchedPaths: ['src/a/b.ts'] });
  assert.ok(ts.text.includes('TS-RULE') && !ts.text.includes('DOCS-RULE') && !ts.text.includes('AGENT-REQUESTED-RULE'));
  const docs = loadInstructions(root, { touchedPaths: ['docs/guide/intro.md'] });
  assert.ok(docs.text.includes('DOCS-RULE') && !docs.text.includes('TS-RULE'));
  assert.deepEqual(parseRule(rule('globs: ["a/**", "b/*.ts"]', 'x')).globs, ['a/**', 'b/*.ts']);
});

test('context.explain: conflicting rules resolve in the documented order, with the winner last', () => {
  const { root, home } = repo({
    '~/HELIX.md': 'Indent with 8 spaces.',
    'CLAUDE.md': 'Indent with tabs.',
    'AGENTS.md': 'Indent with 2 spaces.',
    'src/AGENTS.md': 'Indent with 4 spaces in src.',
    '.cursor/rules/ask.mdc': rule('description: manual\nalwaysApply: false', 'Indent with 3 spaces.'),
  });
  const explained = explainInstructions(root, { helixHome: home, touchedPaths: ['src/x.ts'] });
  assert.equal(explained.conflictRule, CONFLICT_RULE);
  assert.deepEqual(explained.precedence.map((p) => p.scope), ['user', 'repo', 'nested']);
  assert.deepEqual(explained.order, ['~/.helix/HELIX.md', 'CLAUDE.md', 'AGENTS.md', 'src/AGENTS.md']);
  assert.equal(explained.order.at(-1), 'src/AGENTS.md', 'the most specific source wins a conflict');
  const manual = explained.sources.find((s) => s.path === '.cursor/rules/ask.mdc');
  assert.equal(manual?.applied, false);
  assert.match(manual?.reason ?? '', /agent-requested/);
  assert.deepEqual(explained.sources.map((s) => s.rank), [...explained.sources.map((s) => s.rank)].sort((a, b) => a - b));

  const composed = assembleContext({ goal: 'x', instructions: loadInstructions(root, { helixHome: home, touchedPaths: ['src/x.ts'] }) });
  assert.ok(composed.text.includes(CONFLICT_RULE), 'the prompt tells the model which source wins');
  assert.ok(composed.text.lastIndexOf('Indent with 4 spaces in src.') > composed.text.lastIndexOf('Indent with 2 spaces.'));
});

test('imports cannot starve native files: Helix and AGENTS files are budgeted first', () => {
  const { root } = repo({ 'CLAUDE.md': 'c'.repeat(30_000), 'AGENTS.md': 'AGENTS-KEPT' });
  const ins = loadInstructions(root);
  assert.ok(ins.text.includes('AGENTS-KEPT'));
  assert.ok(ins.warnings.some((w) => w.startsWith('CLAUDE.md exceeds')));
  assert.ok(ins.text.indexOf('<instructions source="CLAUDE.md"') < ins.text.indexOf('AGENTS-KEPT'), 'prompt order still follows precedence');
});

test('the engine answers context.explain over RPC and never writes the imported files', async () => {
  const { root, home } = repo({ 'CLAUDE.md': 'claude rule', 'AGENTS.md': 'agents rule' });
  const snapshot = () => [join(root, 'CLAUDE.md'), join(root, 'AGENTS.md')].map((p) => `${readFileSync(p, 'utf8')}@${statSync(p).mtimeMs}`);
  const before = snapshot();
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  const { port, token } = await engine.serve({ ui: false });
  const sock = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(wsTransport(sock));
  try {
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
    const explained = await peer.request(Methods.contextExplain, { workspacePath: root }) as ReturnType<typeof explainInstructions>;
    assert.deepEqual(explained.order, ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(explained.conflictRule, CONFLICT_RULE);
    assert.deepEqual(snapshot(), before, 'instruction files are read-only inputs');
  } finally {
    sock.close();
    await engine.close();
  }
});
