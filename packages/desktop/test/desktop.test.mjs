import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let electron = null;
try { electron = createRequire(import.meta.url)('electron'); } catch { /* not installed */ }
const skip = (!electron || !existsSync(electron)) && 'Electron binary missing (run `pnpm --filter @helix/desktop setup`)';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('desktop shell supervises the Engine and shows the connected workbench (F-AUTH-1, §5.1)', { skip, timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helix-desktop-'));
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), join(here, '..')];
  const app = spawn(electron, args, { env: { ...process.env, HELIX_HOME: home, HELIX_DESKTOP_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  const waiters = [];
  let stdout = '';
  app.stdout.setEncoding('utf8');
  app.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of chunk.split('\n')) {
      const m = line.match(/^helix-desktop (\{.*\})$/);
      if (!m) continue;
      const e = JSON.parse(m[1]);
      events.push(e);
      for (const w of [...waiters]) if (w.match(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    }
  });
  const exited = new Promise((resolve) => app.once('exit', (code, signal) => resolve({ code, signal })));
  const next = (match, ms = 45_000) => new Promise((resolve, reject) => {
    const found = events.find(match);
    if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error(`timed out; events: ${JSON.stringify(events)}`)), ms);
    waiters.push({ match, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });

  try {
    const first = await next((e) => e.event === 'workbench.connected');
    assert.equal(first.title, 'Helix Workbench');
    assert.equal(first.desktop, true, 'preload bridge exposed');
    assert.equal(first.node, 'undefined', 'no Node APIs in the renderer');
    assert.ok(alive(first.pid), 'engine is a separate live process');
    assert.notEqual(first.pid, app.pid);

    process.kill(first.pid, 'SIGKILL');
    await next((e) => e.event === 'engine.exit' && e.pid === first.pid);
    await next((e) => e.event === 'engine.restarting');
    const second = await next((e) => e.event === 'workbench.connected' && e.pid !== first.pid);
    assert.ok(alive(second.pid), 'restarted engine is live');
    assert.equal(second.title, 'Helix Workbench');

    app.kill('SIGTERM');
    await exited;
    for (let i = 0; i < 50 && alive(second.pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(second.pid), false, 'quitting stops the engine');
    assert.ok(!stdout.includes('#token='), 'token never logged');
    t.diagnostic(events.map((e) => `${e.event}${e.pid ? `:${e.pid}` : ''}`).join(' → '));
  } finally {
    if (app.exitCode === null) app.kill('SIGKILL');
    for (const e of events) if (e.pid && alive(e.pid)) process.kill(e.pid, 'SIGKILL');
  }
});
