import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer, type TaskSummary } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { findChrome } from '../src/preview/browser.ts';

const PAGE = `<!doctype html><title>Editor</title><body style="margin:0">
<div data-helix-loc="src/Toolbar.jsx:4:5" class="toolbar" style="height:120px">
  <button data-helix-loc="src/SaveButton.jsx:3:10" class="btn primary" style="position:absolute;left:40px;top:40px;width:140px;height:40px">Save changes</button>
</div>
<p class="note muted" style="position:absolute;left:40px;top:200px;margin:0">Shipping is free over fifty dollars</p>
</body>`;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }),
  'server.js': `const html = require('fs').readFileSync(__dirname + '/page.html', 'utf8');
require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(html); }).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  'page.html': PAGE,
  'src/Toolbar.jsx': `import { SaveButton } from './SaveButton.jsx';\n\nexport function Toolbar() {\n  return (<div className="toolbar">\n    <SaveButton />\n  </div>);\n}\n`,
  'src/SaveButton.jsx': `export function SaveButton() {\n  return (\n    <button className="btn primary">Save changes</button>\n  );\n}\n`,
  'src/Footer.jsx': `export function Footer() {\n  return (\n    <footer>\n      <p className="note muted">Shipping is free over fifty dollars</p>\n    </footer>\n  );\n}\n`,
  'src/Unrelated.jsx': `export const tip = 'Returns are easy';\n`,
};

test('element→source: data-helix-loc, text fallback, and select-and-instruct task (§18.6)', { skip: findChrome() ? false : 'no Chrome/Chromium' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-e2s-'));
  mkdirSync(join(root, 'src'));
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(root, name), body);
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: {}, recover: false, mcp: false, indexing: false });
  try {
    engine.index(root);
    const { port, token } = await engine.serve({ ui: false });
    const sock = await new Promise<WebSocket>((res, rej) => { const s = new WebSocket(`ws://127.0.0.1:${port}/`); s.once('open', () => res(s)); s.once('error', rej); });
    const peer = new RpcPeer(wsTransport(sock));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: [] });
    await assert.rejects(peer.request(Methods.previewLocate, { workspacePath: root, x: 50, y: 50 }), /no dev server/);
    await peer.request(Methods.previewStart, { workspacePath: root }, 90_000);

    const shot = await peer.request(Methods.previewInspect, { workspacePath: root }, 30_000) as { image: string; width: number };
    assert.equal(shot.width, 1280);
    assert.ok(Buffer.from(shot.image, 'base64').subarray(1, 4).toString() === 'PNG');

    type Loc = { card: { tag: string; role: string; name: string; classes: string[] }; source: { path: string; line: number; col?: number; strategy: string; confidence: number; needsConfirm: boolean; chain: string[] } | null; context: string };
    const btn = await peer.request(Methods.previewLocate, { workspacePath: root, x: 100, y: 60 }, 30_000) as Loc;
    assert.equal(btn.card.tag, 'button');
    assert.equal(btn.card.role, 'button');
    assert.equal(btn.card.name, 'Save changes');
    assert.deepEqual(btn.card.classes, ['btn', 'primary']);
    assert.deepEqual(btn.source, { path: 'src/SaveButton.jsx', line: 3, col: 10, strategy: 'attribute', confidence: 1, needsConfirm: false, chain: ['src/Toolbar.jsx:4', 'src/SaveButton.jsx:3'] });
    assert.match(btn.context, /source: src\/SaveButton\.jsx:3 \(via attribute, confidence 1\)/);
    assert.match(btn.context, /component chain: src\/Toolbar\.jsx:4 > src\/SaveButton\.jsx:3/);
    assert.match(btn.context, /<button className="btn primary">Save changes<\/button>/);

    const bar = await peer.request(Methods.previewLocate, { workspacePath: root, x: 600, y: 60 }, 30_000) as Loc;
    assert.equal(bar.source?.path, 'src/Toolbar.jsx');
    assert.equal(bar.source?.confidence, 1, 'attribute on the clicked toolbar div itself');

    const note = await peer.request(Methods.previewLocate, { workspacePath: root, x: 60, y: 205 }, 30_000) as Loc;
    assert.equal(note.card.tag, 'p');
    assert.ok(note.source, note.context);
    assert.equal(note.source.path, 'src/Footer.jsx');
    assert.equal(note.source.line, 4);
    assert.equal(note.source.strategy, 'text');
    assert.ok(note.source.confidence < 1 && note.source.confidence >= 0.5, String(note.source.confidence));
    assert.equal(note.source.needsConfirm, true);

    const r = await peer.request(Methods.previewInstruct, { workspacePath: root, x: 100, y: 60, instruction: 'make this the secondary variant, +8px padding', start: false }, 30_000) as { task: TaskSummary };
    assert.match(r.task.goal, /^make this the secondary variant, \+8px padding/);
    assert.match(r.task.goal, /src\/SaveButton\.jsx:3/);
    assert.match(r.task.goal, /button role=button name="Save changes"/);
    assert.match(r.task.goal, /classes: btn primary/);
    assert.equal(r.task.status, 'planning', 'created, not started (start: false)');

    const confirmed = await peer.request(Methods.previewInstruct, { workspacePath: root, x: 60, y: 205, instruction: 'bold this', path: 'src/Footer.jsx', start: false }, 30_000) as { source: { confidence: number; needsConfirm: boolean } };
    assert.deepEqual([confirmed.source.confidence, confirmed.source.needsConfirm], [1, false]);
    await assert.rejects(peer.request(Methods.previewInstruct, { workspacePath: root, x: 60, y: 205, instruction: 'x', path: '../etc/passwd', start: false }, 30_000), /not a workspace file/);
    sock.close();
  } finally {
    await engine.close();
  }
});
