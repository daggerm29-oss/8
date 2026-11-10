import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientEnv, containerRuntime, describeContainerProbe } from '../../src/sandbox/container.ts';
import { LocalSandbox } from '../../src/sandbox/sandbox.ts';

/**
 * CI diagnostic (R0.8): prints the real reason each `local-container` candidate is accepted or rejected, then runs
 * one real `LocalSandbox.pty()` (the overlay-root PTY path the capability probe does not cover). Exits non-zero on
 * either failure so a runner never reports only "backend unavailable".
 */
for (const cli of ['podman', 'docker']) {
  const v = spawnSync(cli, ['version'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  if (v.error) continue;
  console.log(`$ ${cli} version\n${(v.stdout + v.stderr).trim()}`);
}
const rt = containerRuntime();
console.log(`container probe:\n${describeContainerProbe()}`);
if (!rt) {
  console.error('local-container: no candidate passed the capability probe');
  process.exit(1);
}
console.log(`local-container: selected ${JSON.stringify(rt)}`);

const ws = mkdtempSync(join(tmpdir(), 'helix-ptyprobe-'));
const sbx = new LocalSandbox('probe_pty', ws, { backend: 'local-container' });
let out = '';
let exited = false;
const code = await new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => { p.kill(); resolve(-1); }, 30_000);
  const p = sbx.pty({ cols: 80, rows: 24, onData: (d) => { out += d; if (!exited && out.includes('pty-42')) { exited = true; p.write('exit\r'); } }, onExit: (c) => { clearTimeout(timer); resolve(c); } });
  setTimeout(() => p.write('echo pty-$((6*7))\r'), 500);
});
sbx.destroy();
rmSync(ws, { recursive: true, force: true });
const ok = code === 0 && out.includes('pty-42');
console.log(`LocalSandbox.pty(): exit=${code} ${ok ? 'ok' : 'FAILED'}\n    ${out.trim().replace(/\n/g, '\n    ')}`);
process.exit(ok ? 0 : 1);
