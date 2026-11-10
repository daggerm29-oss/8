import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../../providers/conformance/src/fake-servers.ts';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let repo: string;
let fake: Awaited<ReturnType<typeof startFakeProvider>>;
const errors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'helix-r1-1-'));
  repo = join(root, 'workspace');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/hello.ts'), 'export const greeting = "Hello Helix";\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
  writeFileSync(join(repo, 'server.cjs'), "require('node:http').createServer((req,res)=>res.end('<!doctype html><html><body><h1>Helix fixture preview</h1></body></html>')).listen(process.env.PORT || 3000, '0.0.0.0');\n");
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: repo });
  fake = await startFakeProvider('gemini', () => ({ text: 'Verified desktop agent response.', usage: { input: 10, output: 5 } }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), HELIX_HOME: join(root, 'home'), GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url, GOOGLE_API_KEY: '', GEMINI_API: '', OPENAI_API_KEY: '', HELIX_DESKTOP_HEADLESS: '1' };
  if (process.platform === 'linux' && !env.DISPLAY) {
    const displayNumber = 100 + process.pid % 500;
    env.DISPLAY = `:${displayNumber}`;
    display = spawn('Xvfb', [env.DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: 'pipe' });
    await expect.poll(() => existsSync(`/tmp/.X11-unix/X${displayNumber}`)).toBe(true);
  }
  const executablePath = process.platform === 'linux' ? join(desktop, 'release/linux-unpacked/helix') : process.platform === 'darwin' ? join(desktop, 'release/mac/Helix.app/Contents/MacOS/Helix') : join(desktop, 'release/win-unpacked/helix.exe');
  app = await electron.launch({ executablePath, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 60_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('#engine-status')).toHaveText('Engine connected');
  await page.getByLabel('Workspace path', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'src/hello.ts', exact: true })).toBeVisible();
});
test.afterAll(async () => {
  await app?.close();
  display?.kill('SIGTERM');
  await fake?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('R1.1: packaged panels work; Monaco saves and reloads actual disk bytes', async ({}, testInfo) => {
  await test.step('Explorer and real Monaco open/edit/save/reopen round-trip', async () => {
    await page.getByRole('button', { name: 'src/hello.ts', exact: true }).click();
    await expect(page.getByTestId('monaco-host')).toHaveAttribute('data-ready', 'true');
    const editor = page.getByRole('textbox', { name: 'Code editor', exact: true });
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('// saved from packaged Monaco');
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved to disk' })).toBeVisible();
    expect(readFileSync(join(repo, 'src/hello.ts'), 'utf8')).toContain('// saved from packaged Monaco');
    await page.getByRole('button', { name: 'package.json', exact: true }).click();
    await page.getByRole('button', { name: 'src/hello.ts', exact: true }).click();
    await expect(page.getByTestId('monaco-host')).toHaveAttribute('data-ready', 'true');
    await expect(editor).toHaveValue(/saved from packaged Monaco/);
  });
  await test.step('Sandboxed terminal runs a real command and PTY input/output', async () => {
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Command', exact: true }).fill('printf "desktop-terminal-round-trip"');
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByLabel('Command output', { exact: true })).toContainText('desktop-terminal-round-trip');
    await page.getByRole('button', { name: 'Open shell', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sandbox shell' })).toBeVisible();
    const shell = page.getByTestId('terminal-host').locator('textarea');
    await shell.focus();
    await page.keyboard.type('printf "pty-round-trip\\n"');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('terminal-host')).toContainText('pty-round-trip');
    await page.getByRole('button', { name: 'Close shell', exact: true }).click();
  });
  await test.step('Problems displays parsed command diagnostics and opens source', async () => {
    await page.getByRole('textbox', { name: 'Command', exact: true }).fill("printf 'src/hello.ts(1,1): error TS2322: fixture diagnostic\\n'; exit 1");
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Command exited 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Problems', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Problems panel', exact: true })).toContainText('TS2322 fixture diagnostic');
    await page.getByRole('button', { name: 'src/hello.ts:1', exact: true }).click();
    await expect(page.getByTestId('monaco-host')).toHaveAttribute('data-ready', 'true');
  });
  await test.step('Application preview loads a real sandbox development server', async () => {
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
    await page.getByRole('button', { name: 'Start preview', exact: true }).click();
    await expect(page.frameLocator('#application-preview').getByRole('heading', { name: 'Helix fixture preview' })).toBeVisible({ timeout: 45_000 });
  });
  await test.step('SCM shows real working tree and stages changed files', async () => {
    await page.getByRole('button', { name: 'Source control', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Source control panel', exact: true })).toContainText('fixture');
    await expect(page.getByRole('region', { name: 'Source control panel', exact: true })).toContainText('src/hello.ts');
    await page.getByRole('button', { name: 'Stage all', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Changes staged' })).toBeVisible();
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })).toContain('src/hello.ts');
  });
  await test.step('Settings and MCP manager query the actual Engine', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Settings panel', exact: true })).toContainText('gemini · env');
    await expect(page.getByRole('region', { name: 'Settings panel', exact: true })).toContainText('coder');
    await page.getByRole('button', { name: 'MCP manager', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'MCP manager panel', exact: true })).toContainText('No MCP servers configured');
  });
  await test.step('Agent creates an actual Engine task; monitor displays its outcome', async () => {
    await page.getByRole('textbox', { name: 'Task goal', exact: true }).fill('Respond without calling any tools.');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.getByLabel('Agent conversation', { exact: true })).toContainText('Verified desktop agent response.', { timeout: 45_000 });
    await page.getByRole('button', { name: 'Task monitor', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Task monitor panel', exact: true })).toContainText('Respond without calling any tools.');
    await expect(page.getByRole('region', { name: 'Task monitor panel', exact: true })).toContainText('done');
  });
  expect(errors).toEqual([]);
  await testInfo.attach('workbench', { body: await page.screenshot(), contentType: 'image/png' });
});
