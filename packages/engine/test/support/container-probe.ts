import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { LocalSandbox } from '../../src/sandbox/sandbox.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRootfs, clientEnv, containerRuntime, describeContainerProbe, removeContainerDirectory, runArgs } from '../../src/sandbox/container.ts';

/**
 * CI diagnostic (R0.8): prints the real reason each `local-container` candidate is accepted or rejected and exits
 * non-zero when none works, so a runner never reports only "backend unavailable".
 */
for (const cli of ['podman', 'docker']) {
  const v = spawnSync(cli, ['version'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  if (v.error) continue;
  console.log(`$ ${cli} version\n${(v.stdout + v.stderr).trim()}`);
  const info = spawnSync(cli, ['info', '--debug'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  console.log(`$ ${cli} info --debug (exit ${info.status})\n${(info.stdout + info.stderr).trim()}`);
}
const rt = containerRuntime();
console.log(`container probe:\n${describeContainerProbe()}`);
if (!rt) {
  console.error('local-container: no candidate passed the capability probe');
  process.exit(1);
}
console.log(`local-container: selected ${JSON.stringify(rt)}`);

// PTY variants (diagnostic only): the sandbox PTY path runs `run -t` under util-linux `script`.
if (rt.cli === 'podman') {
  const init = spawnSync('podman', ['info', '--format', '{{.Host.OCIRuntime.Path}}'], { encoding: 'utf8', env: clientEnv() });
  console.log(`oci runtime path: ${init.stdout.trim()}`);
  for (const p of ['/usr/libexec/podman/catatonit', '/usr/bin/catatonit', '/usr/libexec/catatonit/catatonit']) {
    if (existsSync(p)) console.log(`init candidate ${p}: ${spawnSync('ls', ['-lL', p], { encoding: 'utf8' }).stdout.trim()}`);
  }
  const variants: Array<{ label: string; edit: (a: string[]) => string[]; tty: boolean; mode: number }> = [
    { label: 'current (tty, :O overlay root, --init), rootfs 0755', edit: (a) => a, tty: true, mode: 0o755 },
    { label: 'current (tty, :O overlay root, --init), rootfs 0700 (sandbox mkdtemp layout)', edit: (a) => a, tty: true, mode: 0o700 },
    { label: 'tty, :O overlay root, no --init, rootfs 0700', edit: (a) => a.filter((x) => x !== '--init'), tty: true, mode: 0o700 },
    { label: 'tty, --read-only rootfs, --init, rootfs 0700', edit: (a) => withReadOnly(a), tty: true, mode: 0o700 },
    { label: 'no tty, --read-only rootfs, --init, rootfs 0700', edit: (a) => a, tty: false, mode: 0o700 },
  ];
  for (const v of variants) {
    const dir = mkdtempSync(join(tmpdir(), 'helix-ptyprobe-'));
    const rootfs = join(dir, 'root'), scratch = join(dir, 'tmp'), ws = join(dir, 'ws');
    for (const d of [rootfs, scratch, ws]) mkdirSync(d);
    chmodSync(rootfs, v.mode);
    const roPaths = ['/usr', '/etc', '/opt'];
    const extra = buildRootfs(rootfs, roPaths);
    const envFile = join(dir, 'env');
    writeFileSync(envFile, '');
    const args = v.edit(runArgs({ rt, name: `helix-ptyprobe-${process.pid}-${Date.now().toString(36)}`, labels: { 'helix.probe': '1' }, rootfs, roPaths: [...roPaths, ...extra], workspace: ws, scratch, cwd: ws, envFile, tty: v.tty, argv: ['bash', '-c', 'tty; echo pty-ok'] }));
    const quoted = ['podman', ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const r = spawnSync('script', ['-qfec', quoted, '/dev/null'], { encoding: 'utf8', env: clientEnv(), timeout: 60_000 });
    console.log(`pty variant [${v.label}]: exit=${r.status}${r.error ? ` error=${r.error.message}` : ''}\n    ${(r.stdout + r.stderr).trim().replace(/\n/g, '\n    ')}`);
    try { removeContainerDirectory('podman', dir); } catch (e) { console.log(`    cleanup: ${(e as Error).message}`); }
  }
  // Exact sandbox path: LocalSandbox.pty() on a fresh workspace (what the failing conformance case does).
  const ws = mkdtempSync(join(tmpdir(), 'helix-ptyrepro-'));
  const sbx = new LocalSandbox('probe_pty', ws, { backend: 'local-container' });
  let out = '';
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { p.kill(); resolve(-1); }, 20_000);
    const p = sbx.pty({ cols: 80, rows: 24, onData: (d) => { out += d; if (out.includes('pty-42')) p.write('exit\r'); }, onExit: (c) => { clearTimeout(timer); resolve(c); } });
    setTimeout(() => p.write('echo pty-$((6*7))\r'), 500);
  });
  console.log(`LocalSandbox.pty(): exit=${code}\n    ${out.trim().replace(/\n/g, '\n    ')}`);
  sbx.destroy();
}
process.exit(0);

function withReadOnly(a: string[]): string[] {
  const out = a.map((x) => (x.endsWith(':O') ? x.slice(0, -2) : x));
  out.splice(out.indexOf('--network') + 2, 0, '--read-only');
  return out;
}
