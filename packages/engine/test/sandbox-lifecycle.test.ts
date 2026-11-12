import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

/**
 * R1.8 Sandbox lifecycle and resources (F-SBX-5, SEC-12, PERF-9; §16.4). Every check runs on the real default
 * backend; a limit the host cannot enforce fails with the reason instead of being skipped.
 */
const home = mkdtempSync(join(tmpdir(), 'helix-lifecycle-home-'));
process.env.HELIX_HOME = home;
const { LocalSandbox } = await import('../src/sandbox/sandbox.ts');
const { EgressProxy } = await import('../src/sandbox/egress.ts');
const { listSandboxRecords } = await import('../src/sandbox/reaper.ts');
const { Engine } = await import('../src/engine.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roots: string[] = [];
const newWs = () => { const d = mkdtempSync(join(tmpdir(), 'helix-lifecycle-ws-')); roots.push(d); return d; };
const MiB = 1024 * 1024;

before(() => { /* HELIX_HOME is set above, before any module reads it */ });
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function requireLimit(sbx: InstanceType<typeof LocalSandbox>, kind: 'memory' | 'pids' | 'disk'): void {
  const l = sbx.info().limits!;
  assert.ok(l.enforced[kind], `${kind} limit is not enforced on this host: ${l.reason ?? (kind === 'memory' ? 'memory controller unavailable (threaded cgroup subtree)' : 'unknown')}`);
}

test('memory hog is killed at its cgroup limit', async () => {
  const sbx = new LocalSandbox(`life-mem-${process.pid}`, newWs(), { limits: { memoryBytes: 128 * MiB } });
  try {
    requireLimit(sbx, 'memory');
    // `tail` keeps a newline-free stream in memory: 1 GiB against a 128 MiB limit.
    const r = await sbx.exec('head -c 1073741824 /dev/zero | tail > /dev/null; echo "exit=$?"', { timeoutMs: 60_000 });
    assert.equal(r.timedOut, false);
    assert.ok(sbx.limitEvents().oomKills >= 1, `OOM kill recorded (events ${JSON.stringify(sbx.limitEvents())}, out ${r.stdout}${r.stderr})`);
    const alive = await sbx.exec('echo alive');
    assert.match(alive.stdout, /alive/, 'the sandbox survives its OOM kill');
  } finally {
    sbx.destroy();
  }
});

test('fork bomb is stopped by the PID limit', async () => {
  const sbx = new LocalSandbox(`life-pids-${process.pid}`, newWs(), { limits: { pids: 256 } });
  try {
    requireLimit(sbx, 'pids');
    const r = await sbx.exec('bomb() { bomb | bomb & }; bomb; sleep 3; echo bomb-done', { timeoutMs: 8000 });
    assert.ok(sbx.limitEvents().pidsMax >= 1, `pids.max refused forks (events ${JSON.stringify(sbx.limitEvents())}, exit ${r.exitCode})`);
    const alive = await sbx.exec('echo alive');
    assert.match(alive.stdout, /alive/, 'the sandbox recovers after the bomb is killed');
  } finally {
    sbx.destroy();
  }
});

test('disk filler is stopped by the quota', async () => {
  const ws = newWs();
  const sbx = new LocalSandbox(`life-disk-${process.pid}`, ws, { limits: { diskBytes: 32 * MiB } });
  try {
    requireLimit(sbx, 'disk');
    const one = await sbx.exec('dd if=/dev/zero of=big bs=1M count=200 2>&1; echo "dd=$?"', { timeoutMs: 30_000 });
    assert.ok(statSync(join(ws, 'big')).size <= 32 * MiB, `single-file filler capped at the quota (${statSync(join(ws, 'big')).size} bytes)`);
    assert.doesNotMatch(one.stdout, /dd=0/, 'dd reports failure');
    rmSync(join(ws, 'big'));
    const many = await sbx.exec('i=0; while :; do head -c 4194304 /dev/zero > f$i || exit 9; i=$((i+1)); done', { timeoutMs: 30_000 });
    assert.equal(many.timedOut, false, 'multi-file filler killed by the quota watcher, not the timeout');
    assert.ok(sbx.limitEvents().disk >= 1, 'disk quota kill recorded');
    const used = readdirSync(ws).filter((n) => /^f\d+$/.test(n)).length * 4 * MiB;
    assert.ok(used <= 32 * MiB + 16 * MiB, `filler stopped near the quota (${used} bytes written)`);
  } finally {
    sbx.destroy();
  }
});

test('snapshot → suspend → resume restores files and processes', async () => {
  const ws = newWs();
  writeFileSync(join(ws, 'a.txt'), 'v1\n');
  const sbx = new LocalSandbox(`life-snap-${process.pid}`, ws);
  try {
    const counter = await sbx.openStdio('i=0; while :; do i=$((i+1)); echo $i > ctr; sleep 0.05; done', { egress: false });
    counter.process.stdout.resume();
    counter.process.stderr.resume();
    for (let i = 0; i < 100 && !existsSync(join(ws, 'ctr')); i++) await sleep(50);
    const snap = await sbx.snapshot();
    assert.ok(snap.bytes > 0, 'snapshot written');
    const ctr = () => Number(readFileSync(join(ws, 'ctr'), 'utf8').trim() || 0);
    const started = performance.now();
    await sbx.suspend();
    assert.equal(sbx.state, 'suspended');
    const a = ctr();
    await sleep(400);
    assert.equal(ctr(), a, 'processes are frozen while suspended');
    const t0 = performance.now();
    sbx.resume();
    const resumeMs = performance.now() - t0;
    await sleep(400);
    assert.ok(ctr() > a, 'the same process continues after resume');
    assert.equal(counter.process.exitCode, null, 'counter process still alive');
    assert.ok(resumeMs < 2000, `resume within the 2 s warm budget (${resumeMs.toFixed(1)} ms; suspend+resume ${(performance.now() - started).toFixed(0)} ms)`);
    rmSync(join(ws, 'a.txt'));
    await sbx.restore(snap.path);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'v1\n', 'files restored from the snapshot');
    counter.kill();
  } finally {
    sbx.destroy();
  }
});

test('no sentinel secret value appears in snapshot bytes', async () => {
  const ws = newWs();
  const secret = `sk-live-${randomBytes(18).toString('hex')}`;
  const proxy = new EgressProxy({ isAllowed: () => true, onDenied: () => {} });
  const binding = proxy.bind(ws, { name: 'API_TOKEN', value: secret, injectHosts: ['api.example.com'] });
  const sbx = new LocalSandbox(`life-secret-${process.pid}`, ws, { egress: proxy });
  try {
    const r = await sbx.exec('echo "$API_TOKEN" > token.txt; env > /tmp/env.txt; echo ok');
    assert.match(r.stdout, /ok/);
    const snap = await sbx.snapshot();
    const bytes = readFileSync(snap.path);
    assert.ok(bytes.includes(binding.sentinel), 'the sandbox-visible sentinel is in the snapshot (env was captured)');
    assert.equal(bytes.includes(secret), false, 'the real secret value is not in the snapshot');
    assert.equal(bytes.includes(Buffer.from(secret).toString('base64')), false);
  } finally {
    sbx.destroy();
    proxy.close();
  }
});

test('orphaned sandboxes from a killed Engine are reaped on next start', async () => {
  const ws = newWs();
  const tag = `helix-orphan-${randomBytes(4).toString('hex')}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { LocalSandbox } = await import(${JSON.stringify(new URL('../src/sandbox/sandbox.ts', import.meta.url).href)});
    const s = new LocalSandbox('orphan-${tag}', ${JSON.stringify(ws)});
    const p = await s.openStdio('exec -a ${tag} sleep 300', { egress: false });
    p.process.stdout.resume();
    setTimeout(() => console.log(JSON.stringify({ id: s.id, info: s.info() })), 1500);
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, HELIX_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((res) => createInterface({ input: child.stdout! }).once('line', res));
  const { id, info } = JSON.parse(line) as { id: string; info: { provider: string; container?: { cli: string }; limits: { cgroup: string | null } } };
  const sleeping = () => spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const containers = () => info.container ? spawnSync(info.container.cli, ['ps', '-aq', '--filter', `label=helix.sandbox=${id}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean) : [];
  child.kill('SIGKILL');
  await new Promise((r) => child.once('close', r));
  await sleep(300);
  assert.ok(listSandboxRecords().some((r) => r.id === id), 'the dead Engine left an owner record');
  const orphanEvidence = sleeping().length + containers().length + (info.limits.cgroup && existsSync(info.limits.cgroup) ? 1 : 0);
  assert.ok(orphanEvidence >= 1, 'killing the Engine left an orphan (process, container or cgroup)');
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-lifecycle-engine-')), env: {}, mcp: false, indexing: false, recover: false });
  try {
    assert.equal(listSandboxRecords().some((r) => r.id === id), false, 'the record is reaped on Engine start');
    for (let i = 0; i < 50 && (sleeping().length || containers().length); i++) await sleep(100);
    assert.deepEqual(sleeping(), [], 'orphaned sandbox processes are gone');
    assert.deepEqual(containers(), [], 'orphaned containers are gone');
    if (info.limits.cgroup) assert.equal(existsSync(info.limits.cgroup), false, 'orphaned cgroup removed');
  } finally {
    await engine.close();
  }
});
