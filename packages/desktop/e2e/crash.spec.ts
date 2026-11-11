import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../../providers/conformance/src/fake-servers.ts';
import type { TaskActivity } from '@helix/protocol';
import type { HelixDesktopBridge } from '../renderer/desktop-bridge';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let repo: string;
let fake: Awaited<ReturnType<typeof startFakeProvider>>;
let coldStartMs = 0;
const errors: string[] = [];
const events: Record<string, unknown>[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const engineInfo = () => JSON.parse(readFileSync(join(root, 'home/engine.json'), 'utf8')) as { pid: number; port: number; token: string };

/** JSON-RPC straight to the Engine from the test process, so it works while no renderer exists. */
async function call<T>(method: string, params: object = {}): Promise<T> {
  const { port, token } = engineInfo();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'crash-acceptance', protocolVersion: '0.1.0', clientVersion: '0.1.0', token } }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.error) { clearTimeout(timer); socket.close(); reject(new Error(message.error.message)); }
      else if (message.id === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }));
      else if (message.id === 2) { clearTimeout(timer); socket.close(); resolve(message.result as T); }
    };
  });
}
const bridge = <T>(target: Page, fn: (desktop: HelixDesktopBridge) => Promise<T>) =>
  target.evaluate(`(${fn.toString()})(window.helixDesktop)`) as Promise<T>;

async function openWorkspace(target: Page) {
  target.on('pageerror', (error) => errors.push(error.message));
  await expect(target.locator('#engine-status')).toHaveText('Engine connected');
  await target.setViewportSize({ width: 1216, height: 636 });
  await target.getByLabel('Workspace path', { exact: true }).fill(repo);
  await target.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(target.getByRole('button', { name: 'Save layout', exact: true })).toBeEnabled();
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'helix-r1-4-'));
  repo = join(root, 'workspace'); mkdirSync(repo);
  writeFileSync(join(repo, 'hello.txt'), 'before\n');
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: repo });
  fake = await startFakeProvider('gemini', ({ index }) => {
    const usage = { input: 100 + index, output: 10 };
    if (index === 0) return { toolCalls: [{ name: 'run_shell', args: { command: 'sleep 6 && echo survived' } }], delayMs: 50, usage };
    if (index === 1) return { toolCalls: [{ name: 'edit_file', args: { path: 'hello.txt', old_string: 'before', new_string: 'after' } }], delayMs: 50, usage };
    return { text: 'Crash isolation task complete.', usage };
  });
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
    HELIX_HOME: join(root, 'home'), HELIX_DESKTOP_HEADLESS: '1', GEMINI_API_KEY: fake.apiKey,
    HELIX_GEMINI_BASE_URL: fake.url, GEMINI_API: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '',
  };
  if (process.platform === 'linux' && !env.DISPLAY) {
    const number = 100 + (process.pid % 500); env.DISPLAY = `:${number}`;
    display = spawn('Xvfb', [env.DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: 'pipe' });
    await expect.poll(() => existsSync(`/tmp/.X11-unix/X${number}`)).toBe(true);
  }
  const executablePath = process.platform === 'linux' ? join(desktop, 'release/linux-unpacked/helix') : process.platform === 'darwin' ? join(desktop, 'release/mac/Helix.app/Contents/MacOS/Helix') : join(desktop, 'release/win-unpacked/helix.exe');
  const launchedAt = Date.now();
  // No `--no-sandbox`: the renderer runs inside Chromium's OS sandbox as shipped.
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  app.process().stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) { const m = line.match(/^helix-desktop (\{.*\})$/); if (m) events.push(JSON.parse(m[1])); }
  });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  page = await app.firstWindow();
  await expect(page.locator('#engine-status')).toHaveText('Engine connected');
  coldStartMs = Date.now() - launchedAt;
  await openWorkspace(page);
});
test.afterAll(async () => {
  const timer = setTimeout(() => app?.process().kill('SIGKILL'), 10_000);
  try { await app?.close(); }
  finally { clearTimeout(timer); display?.kill('SIGTERM'); await fake?.close(); if (root) rmSync(root, { recursive: true, force: true }); }
});

test('R1.4 packaged hardening: strict CSP, sandboxed renderer, validated IPC allowlist; renderer crash leaves Engine and task alive and the reopened window reattaches', async ({}, testInfo) => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Record<string, unknown> };
    const p = contents.getLastWebPreferences();
    return { sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, webviewTag: p.webviewTag, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames };
  });
  expect(prefs).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false, nodeIntegrationInSubFrames: false });
  expect(await page.evaluate(() => [typeof (globalThis as any).require, typeof (globalThis as any).process, typeof (globalThis as any).module])).toEqual(['undefined', 'undefined', 'undefined']);
  expect(page.url()).not.toContain('token=');

  const csp = await page.evaluate(async () => (await fetch(location.href, { cache: 'no-store' })).headers.get('content-security-policy') || '');
  expect(csp).toMatch(/script-src 'self'(;|$)/);
  expect(csp).not.toMatch(/frame-ancestors\s+\*/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  const inline = await page.evaluate(() => new Promise<{ ran: boolean; violated: string }>((resolve) => {
    let violated = '';
    document.addEventListener('securitypolicyviolation', (e) => { violated = e.violatedDirective; }, { once: true });
    const script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true';
    document.head.append(script);
    setTimeout(() => resolve({ ran: (window as any).__inlineRan === true, violated }), 200);
  }));
  expect(inline.ran).toBe(false);
  expect(inline.violated).toMatch(/script-src/);

  const unlisted = await page.evaluate(() => (window as any).helixDesktop.invoke('fs.readFile', { path: '/etc/passwd' }).then(() => 'resolved', (e: Error) => e.message));
  expect(unlisted).toBe('IPC channel not allowed: fs.readFile');
  const badPayload = await page.evaluate(() => (window as any).helixDesktop.invoke('shell.openExternal', { url: 'file:///etc/passwd' }).then(() => 'resolved', (e: Error) => e.message));
  expect(badPayload).toMatch(/invalid url scheme/);
  await expect.poll(() => events.filter((e) => e.event === 'ipc.rejected').length).toBeGreaterThanOrEqual(2);
  const info = await bridge(page, (d) => d.appInfo());
  expect(info.packaged).toBe(true);
  const before = await bridge(page, (d) => d.engineStatus());
  const enginePid = engineInfo().pid;
  expect(before.pid).toBe(enginePid);

  const task = await call<{ id: string }>('task.create', { workspacePath: repo, goal: 'Survive a renderer crash.', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless' });
  await page.getByRole('button', { name: 'Task monitor', exact: true }).first().click();
  await page.getByRole('button', { name: 'Survive a renderer crash.', exact: true }).click();
  await expect.poll(async () => (await call<TaskActivity>('task.activity', { task: task.id })).agents.flatMap((a) => a.steps.flatMap((s) => s.tools)).some((c) => c.tool === 'run_shell')).toBe(true);
  expect((await call<TaskActivity>('task.activity', { task: task.id })).status).toBe('running');

  const rendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
  expect(rendererPid).not.toBe(enginePid);
  const reopened = app.waitForEvent('window', { timeout: 30_000 });
  process.kill(rendererPid, 'SIGKILL');
  const killedAt = Date.now();
  await expect.poll(() => events.some((e) => e.event === 'renderer.gone')).toBe(true);
  expect(alive(enginePid)).toBe(true);
  const during = await call<TaskActivity>('task.activity', { task: task.id });
  expect(during.status).toBe('running');
  expect(fake.requests.length).toBe(1);

  const next = await reopened;
  await openWorkspace(next);
  const reattachMs = Date.now() - killedAt;
  expect(engineInfo().pid).toBe(enginePid);
  const after = await bridge(next, (d) => d.engineStatus());
  expect(after).toMatchObject({ pid: enginePid, alive: true, restarts: 0, rendererCrashes: 1 });
  expect(events.filter((e) => e.event === 'engine.exit')).toEqual([]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  await next.getByRole('button', { name: 'Task monitor', exact: true }).first().click();
  await next.getByRole('button', { name: 'Survive a renderer crash.', exact: true }).click();
  const tree = next.getByRole('region', { name: 'Live agent activity', exact: true });
  await expect(tree.getByRole('status').first()).toHaveText('done', { timeout: 30_000 });
  await expect(tree.locator('[data-tool-call]').first()).toContainText('run_shell');
  expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('after\n');
  const final = await call<TaskActivity>('task.activity', { task: task.id });
  expect(final.status).toBe('done');
  expect(fake.requests.length).toBe(3);
  const unlistedAfter = await next.evaluate(() => (window as any).helixDesktop.invoke('engine.kill').then(() => 'resolved', (e: Error) => e.message));
  expect(unlistedAfter).toBe('IPC channel not allowed: engine.kill');
  expect(errors).toEqual([]);

  const evidence = {
    task: 'R1.4', packagedElectron: true, chromiumOsSandbox: 'enabled (launched without --no-sandbox)', webPreferences: prefs, csp, inlineScript: inline, ipc: { unlisted, badPayload, unlistedAfterReopen: unlistedAfter, allowlist: ['app.info', 'engine.connection', 'engine.status', 'shell.openExternal'] },
    crash: { rendererPid, enginePid, engineAliveAfterKill: true, taskStatusDuringCrash: during.status, reopenedWindowReattachedMs: reattachMs, finalTaskStatus: final.status, providerRequests: fake.requests.length, rendererCrashes: after.rendererCrashes },
    coldStartToConnectedMs: { value: coldStartMs, note: 'local packaged Electron under Xvfb in the build VM; not PERF-1 reference-hardware certification' },
    events: events.map((e) => e.event), pageErrors: errors,
  };
  const path = join(desktop, '../../evals/results/r1-4-packaged-hardening-2026-11-11.json');
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
  await testInfo.attach('R1.4 actual evidence', { path, contentType: 'application/json' });
});
