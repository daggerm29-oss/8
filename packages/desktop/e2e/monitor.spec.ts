import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../../providers/conformance/src/fake-servers.ts';
import type { TaskActivity } from '@helix/protocol';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let repo: string;
let fake: Awaited<ReturnType<typeof startFakeProvider>>;
const errors: string[] = [];
async function call<T>(method: string, params: object = {}): Promise<T> {
  const { token } = JSON.parse(readFileSync(join(root, 'home/engine.json'), 'utf8'));
  return page.evaluate(async ({ method, params, token }) => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
      socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'monitor-acceptance', protocolVersion: '0.1.0', clientVersion: '0.1.0', token } }));
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data));
        if (message.error) { clearTimeout(timer); socket.close(); reject(new Error(message.error.message)); }
        else if (message.id === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }));
        else if (message.id === 2) { clearTimeout(timer); socket.close(); resolve(message.result); }
      };
    });
  }, { method, params, token }) as Promise<T>;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'helix-r1-3-'));
  repo = join(root, 'workspace'); mkdirSync(repo);
  writeFileSync(join(repo, 'hello.txt'), 'before\n');
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: repo });
  fake = await startFakeProvider('gemini', ({ index, request }) => {
    if (JSON.stringify(request.body).includes('cancel monitor task')) return { toolCalls: [{ name: 'run_shell', args: { command: 'sleep 30' } }], delayMs: 150, usage: { input: 100, output: 5 } };
    const usage = { input: 100 + index, output: 10 };
    if (index === 0) return { toolCalls: [{ name: 'explore', args: { question: 'Read hello.txt and report its current content.' } }], delayMs: 350, usage };
    if (index === 1) return { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }], delayMs: 800, usage };
    if (index === 2) return { text: 'hello.txt:1 contains before.', delayMs: 80, usage };
    if (index === 3) return { toolCalls: [{ name: 'edit_file', args: { path: 'hello.txt', old_string: 'before', new_string: 'after' } }], delayMs: 80, usage };
    if (index === 4) return { toolCalls: [{ name: 'run_shell', args: { command: 'sleep 1' } }], delayMs: 80, usage };
    if (index < 35) return { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }], delayMs: 35, usage };
    return { text: 'Monitor task complete.', usage };
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
  app = await electron.launch({ executablePath, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 60_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('#engine-status')).toHaveText('Engine connected');
  await page.setViewportSize({ width: 1216, height: 636 });
  await page.getByLabel('Workspace path', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save layout', exact: true })).toBeEnabled();
});
test.afterAll(async () => {
  const timer = setTimeout(() => app?.process().kill('SIGKILL'), 10_000);
  try { await app?.close(); }
  finally { clearTimeout(timer); display?.kill('SIGTERM'); await fake?.close(); if (root) rmSync(root, { recursive: true, force: true }); }
});

test('R1.3 packaged live nested tree, budgets, leases, checkpoints, pause/resume/cancel/rollback and engine-to-panel p95 ≤ 50 ms', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Task monitor', exact: true }).first().click();
  const task = await call<{ id: string }>('task.create', { workspacePath: repo, goal: 'Run the activity monitor acceptance.', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless', budgetUsd: 2 });
  await page.getByRole('button', { name: 'Run the activity monitor acceptance.', exact: true }).click();
  const tree = page.getByRole('region', { name: 'Live agent activity', exact: true });
  await expect(tree.getByText('Explore subagent', { exact: true })).toBeVisible();
  await tree.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(tree.getByRole('status').first()).toHaveText('paused');
  const paused = await call<TaskActivity>('task.activity', { task: task.id });
  const count = paused.agents.flatMap((a) => a.steps.flatMap((s) => s.tools)).filter((c) => c.checkpoint).length;
  await new Promise((r) => setTimeout(r, 150));
  const stable = await call<TaskActivity>('task.activity', { task: task.id });
  expect(stable.agents.flatMap((a) => a.steps.flatMap((s) => s.tools)).filter((c) => c.checkpoint)).toHaveLength(count);
  expect(fake.requests.length).toBe(2);
  await page.evaluate(() => {
    const samples: number[] = [];
    const node = document.querySelector<HTMLElement>('.activity-tree')!;
    const observer = new MutationObserver(() => {
      if (node.dataset.eventAt && node.dataset.committedAt) {
        const sent = Number(node.dataset.eventAt);
        const committed = Number(node.dataset.committedAt);
        if (committed >= sent) samples.push(committed - sent);
      }
    });
    observer.observe(node, { attributes: true, attributeFilter: ['data-event-at', 'data-committed-at'] });
    (window as any).__monitorSamples = samples;
  });
  await tree.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(tree.locator('[data-agent="primary"] [aria-label="Subagents"] [data-tool-call]').first()).toContainText('read_file');
  await expect(tree.getByText('Hard $2.0000', { exact: false })).toBeVisible();
  await expect(tree.locator('[data-lease-state="held"]')).toBeVisible();
  await expect.poll(() => readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('after\n');
  await expect(tree.getByRole('status').first()).toHaveText('done');
  const activity = await call<TaskActivity>('task.activity', { task: task.id });
  const child = activity.agents.find((a) => a.kind === 'explore')!;
  expect(child.parent).toBe('primary');
  expect(child.steps[0].tools[0].checkpoint).toBeTruthy();
  expect(activity.leases.every((l) => l.state === 'released')).toBe(true);
  const edit = activity.agents[0].steps.flatMap((s) => s.tools).find((c) => c.tool === 'edit_file')!;
  await tree.getByLabel('Rollback checkpoint', { exact: true }).selectOption(edit.checkpoint);
  page.once('dialog', (dialog) => dialog.accept());
  await tree.getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(tree.getByText(/Checkpoint restored/)).toBeVisible();
  expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('before\n');
  await tree.getByText('Prompt composition (estimated tokens)', { exact: true }).first().click();
  await expect(tree.locator('.activity-context dl').first()).toContainText('system');
  await expect(tree.getByRole('list', { name: 'Prompt context items', exact: true }).first()).toContainText('prompt: system');
  await expect(tree.locator('[data-task-node]')).toContainText('Task · Run the activity monitor acceptance.');
  const samples = await page.evaluate(() => (window as any).__monitorSamples as number[]);
  expect(samples.length).toBeGreaterThanOrEqual(30);
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * .95) - 1];
  expect(p95).toBeLessThanOrEqual(50);
  const cancelled = await call<{ id: string }>('task.create', { workspacePath: repo, goal: 'cancel monitor task', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless' });
  await page.getByRole('button', { name: 'cancel monitor task', exact: true }).click();
  await expect(tree.locator('[data-lease-state="held"]')).toBeVisible();
  await tree.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tree.getByRole('status').first()).toHaveText('cancelled');
  expect((await call<TaskActivity>('task.activity', { task: cancelled.id })).leases.some((l) => l.state === 'held')).toBe(false);
  await page.getByRole('button', { name: 'Run the activity monitor acceptance.', exact: true }).click();
  await tree.getByLabel('Rollback checkpoint', { exact: true }).selectOption(edit.checkpoint);
  await tree.getByRole('button', { name: 'Fork checkpoint', exact: true }).click();
  await expect(tree.locator('[data-task-node]')).toContainText('Task · Fork of Run the activity monitor acceptance.');
  await expect(tree.getByRole('status').first()).toHaveText('paused');
  await tree.getByLabel('Task model', { exact: true }).selectOption('gemini/gemini-3.5-flash-lite');
  await tree.getByRole('button', { name: 'Change model', exact: true }).click();
  await expect(tree.getByText('Model updated to gemini/gemini-3.5-flash-lite.')).toBeVisible();
  await tree.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(tree.getByRole('status').first()).toHaveText('done');
  await expect(tree.locator('[data-step]').first()).toContainText('gemini/gemini-3.5-flash-lite');
  expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('before\n');
  expect(errors).toEqual([]);
  const evidence = { task: 'R1.3', packagedElectron: true, model: 'protocol-faithful fake Gemini HTTP server (not model quality)', tree: 'Task → Primary agent → Step → explore ToolCall → Explore subagent → Step → read_file', controls: ['pause: no new primary/nested tool calls', 'resume: continued same subagent', 'cancel: actual sandbox sleep stopped, lease released', 'rollback: hello.txt after → before', 'fork: forked before edit_file into paused branch', 'change model: switched fork to gemini/gemini-3.5-flash-lite and completed'], budgetUsd: 2, checkpoints: activity.checkpoints.length, latency: { measurement: 'Engine snapshot emittedAt → renderer useLayoutEffect DOM commit; local packaged Electron, not reference-hardware certification', samplesMs: samples, count: samples.length, p95Ms: p95 }, pageErrors: errors };
  const path = join(desktop, '../../evals/results/r1-3-packaged-monitor-2026-11-11.json');
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
  await testInfo.attach('R1.3 actual evidence', { path, contentType: 'application/json' });
});
