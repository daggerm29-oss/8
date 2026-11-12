import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerTotals, TraceSpan } from '@helix/protocol';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let fixture: { home: string; repo: string; task: string; spans: TraceSpan[]; ledger: LedgerTotals; entries: object[] };
const errors: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  root = mkdtempSync(join(tmpdir(), 'helix-r1-6-'));
  const output = join(root, 'r0-5-fixture.json');
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-name-pattern=R0.5:', 'test/trace-audit.test.ts'], { cwd: join(desktop, '../engine'), env: { ...process.env, HELIX_TRACE_FIXTURE_OUT: output }, stdio: 'inherit', timeout: 240_000 });
  fixture = JSON.parse(readFileSync(output, 'utf8'));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), HELIX_HOME: fixture.home, HELIX_DESKTOP_HEADLESS: '1', GEMINI_API: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '' };
  if (process.platform === 'linux' && !env.DISPLAY) {
    const number = 100 + process.pid % 500; env.DISPLAY = `:${number}`;
    display = spawn('Xvfb', [env.DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: 'pipe' });
    await expect.poll(() => existsSync(`/tmp/.X11-unix/X${number}`)).toBe(true);
  }
  const executablePath = process.platform === 'linux' ? join(desktop, 'release/linux-unpacked/helix') : process.platform === 'darwin' ? join(desktop, 'release/mac/Helix.app/Contents/MacOS/Helix') : join(desktop, 'release/win-unpacked/helix.exe');
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await app.evaluate(({ session }, dir) => { session.defaultSession.on('will-download', (_event, item) => item.setSavePath(dir + '/' + item.getFilename())); }, root);
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('#engine-status')).toHaveText('Engine connected');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Workspace path', { exact: true }).fill(fixture.repo);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save layout', exact: true })).toBeEnabled();
});
test.afterAll(async () => {
  const timer = setTimeout(() => app?.process().kill('SIGKILL'), 10_000);
  try { await app?.close(); }
  finally { clearTimeout(timer); display?.kill('SIGTERM'); if (root) rmSync(root, { recursive: true, force: true }); }
});

test('R1.6 packaged dashboard: actual R0.5 ledger, five dimensions, downloaded exports, full original span tree', async ({}, info) => {
  await page.getByRole('button', { name: 'Ledger & traces', exact: true }).first().click();
  const panel = page.getByRole('region', { name: 'Ledger dashboard', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('Ledger task', { exact: true }).selectOption(fixture.task);
  await expect(panel.locator('[data-metric="calls"]')).toHaveText(String(fixture.ledger.calls));
  for (const metric of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) await expect(panel.locator(`[data-metric="${metric}"]`)).toHaveText(String(fixture.ledger[metric]));
  await expect(panel.locator('[data-metric="costUsd"]')).toHaveText('$' + fixture.ledger.costUsd.toFixed(4));
  const grouped: Record<string, string[]> = {};
  for (const dimension of ['agent', 'task', 'tool', 'provider', 'model']) {
    await panel.getByLabel('Ledger grouping', { exact: true }).selectOption(dimension);
    await expect(panel.locator('[data-ledger-group]').first()).toBeVisible();
    grouped[dimension] = await panel.locator('[data-ledger-group]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-ledger-group')!));
    expect(grouped[dimension].length).toBeGreaterThan(0);
  }
  for (const format of ['JSON', 'CSV']) {
    await panel.getByRole('button', { name: 'Export ' + format, exact: true }).click();
    const path = join(root, 'helix-ledger.' + format.toLowerCase());
    await expect.poll(() => existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    if (format === 'JSON') expect(JSON.parse(content)).toEqual(fixture.entries);
    else { expect(content).toContain('"input_tokens"'); expect(content).toContain(fixture.task); expect(content.split('\r\n').length).toBe(fixture.entries.length + 2); }
  }
  const tree = panel.getByRole('list', { name: 'Trace span tree', exact: true });
  await expect(tree.locator('[data-span]')).toHaveCount(fixture.spans.length);
  for (const span of fixture.spans) {
    const rendered = tree.locator(`[data-span="${span.spanId}"]`);
    await expect(rendered).toHaveAttribute('data-span-name', span.name);
    if (span.parentSpanId && fixture.spans.some((parent) => parent.spanId === span.parentSpanId)) await expect(rendered.locator('..').locator('..').locator('..')).toHaveAttribute('data-span', span.parentSpanId);
  }
  expect(new Set(fixture.spans.map((span) => span.name))).toEqual(new Set(['task', 'agent.step', 'model.call', 'tool.call', 'gate.run', 'sandbox.exec', 'retrieval.query', 'snapshot.build']));
  const attrs = tree.getByText('Span attributes and events', { exact: true }).first();
  await attrs.focus(); await page.keyboard.press('Enter');
  await expect(tree.locator('pre').first()).toBeVisible();
  const axe = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations).toEqual([]); expect(errors).toEqual([]);
  const evidence = { packaged: true, source: 'Actual R0.5 acceptance task persisted SQLite, not a fabricated UI trace', task: fixture.task, totals: fixture.ledger, grouped, spans: fixture.spans, axeViolations: axe.violations, errors };
  writeFileSync(join(desktop, '../../evals/results/r1-6-ledger-2026-11-11.json'), JSON.stringify(evidence, null, 2) + '\n');
  await info.attach('ledger-trace', { body: JSON.stringify(evidence), contentType: 'application/json' });
});
