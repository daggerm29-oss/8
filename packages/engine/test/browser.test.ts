import { sandboxProcAvailable } from '../src/sandbox/sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { findChrome } from '../src/preview/browser.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

const PAGE = `<!doctype html><title>Fixture App</title><h1>Hello fixture</h1>
<script>console.log('booted'); console.error('fixture console error'); setTimeout(() => { throw new Error('fixture uncaught'); }, 0);</script>`;
const SERVER = `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(${JSON.stringify(PAGE)}); })
  .listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));\n`;

function fixture(): string {
  const root = tmp('helix-browser-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }));
  writeFileSync(join(root, 'server.js'), SERVER);
  return root;
}

test('agent takes a preview screenshot and reads console errors of the fixture page (F-PRV-5)', { skip: findChrome() && sandboxProcAvailable() ? false : 'no Chrome/Chromium, or the sandbox cannot give a contained browser a private /proc on this host' }, async () => {
  const root = fixture();
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'preview_screenshot', args: {} }], usage: { input: 50, output: 5 } },
    { toolCalls: [{ name: 'start_dev_server', args: {} }], usage: { input: 100, output: 5 } },
    { toolCalls: [{ name: 'preview_screenshot', args: { path: '/' } }], usage: { input: 150, output: 5 } },
    { toolCalls: [{ name: 'preview_console', args: {} }], usage: { input: 200, output: 5 } },
    { toolCalls: [{ name: 'preview_console', args: { path: 'http://example.com/' } }], usage: { input: 250, output: 5 } },
    { text: 'Checked the page.', usage: { input: 300, output: 5 } },
  ];
  const fake = await startFakeProvider('gemini', scripted(turns));
  const home = tmp('helix-home-');
  const engine = new Engine({ home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false, indexing: false });
  try {
    const created = engine.runtime.create({ workspacePath: root, goal: 'check the page', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless', verifyCommand: 'node -e 0' });
    const done = await engine.runtime.wait(created.id, 120_000);
    assert.equal(done.status, 'done', done.error ?? '');
    const results = engine.runtime.transcript(created.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as Array<{ content: string; isError?: boolean }>;
    assert.equal(results.length, 5, JSON.stringify(results.map((r) => r.content.slice(0, 80))));
    const [noServer, , shot, cons, offsite] = results;

    assert.equal(noServer.isError, true);
    assert.match(noServer.content, /call start_dev_server first/);

    assert.ok(!shot.isError, shot.content);
    const pngPath = /screenshot saved: (\S+\.png)/.exec(shot.content)?.[1];
    assert.ok(pngPath && existsSync(pngPath), shot.content);
    assert.ok(pngPath.startsWith(join(home, 'screenshots')));
    assert.deepEqual([...readFileSync(pngPath).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.match(shot.content, /title: Fixture App/);
    assert.match(shot.content, /Hello fixture/);
    assert.match(shot.content, /\[error\] fixture console error/);

    assert.ok(!cons.isError, cons.content);
    assert.match(cons.content, /\[log\] booted/);
    assert.match(cons.content, /\[error\] fixture console error/);
    assert.match(cons.content, /\[error\] .*fixture uncaught/);

    assert.equal(offsite.isError, true);
    assert.match(offsite.content, /must stay on the dev server/);
  } finally {
    await engine.close();
    await fake.close();
  }
});
