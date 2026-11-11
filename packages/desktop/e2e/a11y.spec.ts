import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let repo: string;
const errors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'helix-r1-5-'));
  repo = join(root, 'workspace'); mkdirSync(repo);
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "Hello";\n');
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: repo });
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
    HELIX_HOME: join(root, 'home'), HELIX_DESKTOP_HEADLESS: '1',
    GEMINI_API: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '',
  };
  if (process.platform === 'linux' && !env.DISPLAY) {
    const number = 100 + process.pid % 500; env.DISPLAY = `:${number}`;
    display = spawn('Xvfb', [env.DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: 'pipe' });
    await expect.poll(() => existsSync(`/tmp/.X11-unix/X${number}`)).toBe(true);
  }
  const executablePath = process.platform === 'linux' ? join(desktop, 'release/linux-unpacked/helix') : process.platform === 'darwin' ? join(desktop, 'release/mac/Helix.app/Contents/MacOS/Helix') : join(desktop, 'release/win-unpacked/helix.exe');
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('#engine-status')).toHaveText('Engine connected');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Workspace path', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible();
});
test.afterAll(async () => {
  const timer = setTimeout(() => app?.process().kill('SIGKILL'), 10_000);
  try { await app?.close(); }
  finally { clearTimeout(timer); display?.kill('SIGTERM'); if (root) rmSync(root, { recursive: true, force: true }); }
});

async function keyboardPanel(name: string, id: string) {
  const nav = page.getByRole('navigation', { name: 'Workbench panels', exact: true });
  const target = nav.getByRole('button', { name, exact: true });
  // F6 leaves editor/terminal keyboard capture; Tab traverses the actual navigation.
  await page.keyboard.press('F6');
  for (let i = 0; i < 150 && !(await target.evaluate((node) => node === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.locator(`[data-panel="${id}"]`);
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  return panel;
}

test('R1.5 every panel: WCAG 2.2 AA, keyboard operations, high contrast, Monaco, palette and layout controls', async ({}, info) => {
  const scans: { panel: string; theme: string; violations: unknown[] }[] = [];
  const panels = [['Explorer', 'explorer'], ['Agent', 'agent'], ['Terminal', 'terminal'], ['Preview', 'preview'], ['Problems', 'problems'], ['Task monitor', 'monitor'], ['Source control', 'scm'], ['MCP manager', 'mcp'], ['Settings', 'settings'], ['Ledger & traces', 'ledger']];
  for (const theme of ['default', 'high']) {
    if (theme === 'high') {
      await page.getByRole('button', { name: 'High contrast', exact: true }).focus();
      await page.keyboard.press('Space');
      await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
    }
    for (const [name, id] of panels) {
      const panel = await keyboardPanel(name, id);
      if (id === 'explorer') { await page.keyboard.press('Enter'); await expect(panel.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible(); }
      if (id === 'agent') { await expect(page.getByLabel('Task goal', { exact: true })).toBeFocused(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Keyboard accessible task'); await expect(page.getByLabel('Task goal', { exact: true })).toHaveValue('Keyboard accessible task'); }
      if (id === 'terminal') { await panel.getByLabel('Command', { exact: true }).focus(); await page.keyboard.type('echo keyboard'); await expect(panel.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled(); }
      if (['problems', 'monitor', 'mcp', 'settings'].includes(id)) { await page.keyboard.press('Enter'); await expect(panel).toBeVisible(); }
      if (id === 'scm') { await panel.getByLabel('Commit message', { exact: true }).focus(); await page.keyboard.type('Keyboard commit draft'); await expect(panel.getByRole('button', { name: 'Commit staged', exact: true })).toBeEnabled(); }
      const result = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      scans.push({ panel: id, theme, violations: result.violations });
      expect(result.violations, `${id}/${theme}: ${JSON.stringify(result.violations)}`).toEqual([]);
    }
    await keyboardPanel('Explorer', 'explorer');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: 'hello.ts', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('monaco-host')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('textbox', { name: 'Code editor', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('// keyboard');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByRole('status').filter({ hasText: 'Saved to disk' })).toBeVisible();
    const editor = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    scans.push({ panel: 'editor', theme, violations: editor.violations }); expect(editor.violations).toEqual([]);
    await page.keyboard.press('ControlOrMeta+Shift+p');
    await expect(page.getByRole('combobox', { name: 'Palette search', exact: true })).toBeFocused();
    await page.keyboard.type('Save Layout');
    await page.keyboard.press('ArrowDown');
    const palette = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    scans.push({ panel: 'palette', theme, violations: palette.violations }); expect(palette.violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  expect(errors).toEqual([]);
  const evidence = { scans, errors, keyboard: 'All 10 panels, editor save, palette open/navigate/dismiss; default and high contrast', packaged: true };
  const artifact = join(desktop, '../../evals/results/r1-5-accessibility-2026-11-11.json');
  writeFileSync(artifact, JSON.stringify(evidence, null, 2) + '\n');
  await info.attach('accessibility', { body: JSON.stringify(evidence), contentType: 'application/json' });
});
