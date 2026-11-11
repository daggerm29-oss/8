import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const require = createRequire(import.meta.url);
const { RENDERER_CSP, IPC_CHANNELS, windowWebPreferences, validateIpcRequest, parseCsp, cspViolations } = require('../security.cjs');

test('renderer CSP is strict: no frame-ancestors *, no unsafe-inline scripts (SEC-13)', () => {
  const csp = parseCsp(RENDERER_CSP);
  assert.deepEqual(cspViolations(RENDERER_CSP), []);
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.ok(!csp['script-src'].includes("'unsafe-inline'"));
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.match(readFileSync(join(desktop, 'main.cjs'), 'utf8'), /onHeadersReceived[\s\S]*RENDERER_CSP/, 'main process enforces RENDERER_CSP on Engine responses');
  assert.deepEqual(cspViolations("script-src 'self' 'unsafe-inline'; frame-ancestors *"), ["script-src allows 'unsafe-inline'", 'frame-ancestors allows *', "object-src is not 'none'", 'no base-uri']);
});

test('Engine serves strict CSP for the desktop and legacy workbench (SEC-13)', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-hardening-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  const engine = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(desktop, '../engine/src/main.ts'), '--ws', '0', '--ui', '--desktop-ui', root], { env: { ...process.env, HELIX_HOME: join(root, 'home') }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`engine not ready: ${buf}`)), 45_000);
      engine.stderr.setEncoding('utf8');
      engine.stderr.on('data', (c) => { buf += c; const m = buf.match(/workbench: (http:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      engine.once('exit', (code) => reject(new Error(`engine exited ${code}: ${buf}`)));
    });
    const origin = new URL(url).origin;
    for (const path of ['/desktop/index.html', '/index.html']) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      const header = res.headers.get('content-security-policy');
      assert.deepEqual(cspViolations(header), [], `${path}: ${header}`);
      assert.ok(!/frame-ancestors\s+\*/.test(header), path);
    }
  } finally {
    engine.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderer is sandboxed with no Node integration (SEC-13)', () => {
  const prefs = windowWebPreferences({ preload: '/x/preload.cjs' });
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.webSecurity, true);
  assert.ok(Object.isFrozen(prefs));
  const main = readFileSync(join(desktop, 'main.cjs'), 'utf8');
  assert.match(main, /webPreferences: windowWebPreferences\(/);
  assert.doesNotMatch(main, /nodeIntegration:\s*true|sandbox:\s*false|contextIsolation:\s*false/);
  const preload = readFileSync(join(desktop, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer|require:\s|process:\s/, 'preload exposes no raw IPC or Node objects');
});

test('IPC allowlist accepts only real channels with valid payloads (SEC-13)', () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), ['app.info', 'engine.connection', 'engine.status', 'shell.openExternal']);
  for (const channel of ['app.info', 'engine.connection', 'engine.status']) assert.equal(validateIpcRequest({ id: 1, channel }).ok, true, channel);
  assert.equal(validateIpcRequest({ id: 2, channel: 'shell.openExternal', payload: { url: 'https://example.com/docs' } }).ok, true);
  const rejected = (message, pattern) => {
    const r = validateIpcRequest(message);
    assert.equal(r.ok, false, JSON.stringify(message));
    assert.match(r.error, pattern);
  };
  rejected({ id: 3, channel: 'fs.readFile', payload: { path: '/etc/passwd' } }, /IPC channel not allowed: fs\.readFile/);
  rejected({ id: 4, channel: 'constructor' }, /not allowed/);
  rejected({ id: 5, channel: '__proto__' }, /not allowed/);
  rejected({ id: 6, channel: 'toString' }, /not allowed/);
  rejected({ id: 7, channel: 'shell.openExternal', payload: { url: 'file:///etc/passwd' } }, /invalid url scheme/);
  rejected({ id: 8, channel: 'shell.openExternal', payload: { url: 'javascript:alert(1)' } }, /invalid url scheme/);
  rejected({ id: 9, channel: 'shell.openExternal', payload: { url: 'https://a.example', extra: 1 } }, /payload must be/);
  rejected({ id: 10, channel: 'shell.openExternal', payload: { url: 'https://u:p@a.example' } }, /credentials/);
  rejected({ id: 11, channel: 'engine.status', payload: { x: 1 } }, /payload not accepted/);
  rejected({ id: 12, channel: 'app.info', admin: true }, /unexpected fields/);
  rejected({ id: 13, channel: 7 }, /must be a string/);
  assert.deepEqual(validateIpcRequest({ channel: 'app.info' }), { ok: false, id: null, error: 'IPC request must have a positive integer id' });
  assert.equal(validateIpcRequest(null).ok, false);
});
