/**
 * M1 demo eval against a LIVE provider (roadmap T7):
 *   open the `fixtures/m1/web-hello` workspace, ask "change the page heading to Hello Helix"; the agent installs
 *   deps through the egress proxy, starts the dev server, edits, confirms with preview_screenshot, the `npm test`
 *   gate passes, then the change is committed through the Git panel RPCs (git.stageAll + git.commit).
 *
 * Run: set -a; . ./.env.development.local; set +a; node --disable-warning=ExperimentalWarning evals/m1-demo.ts [--model gemini-3.5-flash-lite]
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PassThrough } from 'node:stream';
import { Methods, PROTOCOL_VERSION, RpcPeer, streamTransport } from '../packages/protocol/src/index.ts';
import { Engine } from '../packages/engine/src/engine.ts';

const { values } = parseArgs({ options: { provider: { type: 'string', default: 'gemini' }, model: { type: 'string', default: 'gemini-3.5-flash-lite' } } });
const FIXTURE = fileURLToPath(new URL('../fixtures/m1/web-hello/', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const dir = mkdtempSync(join(tmpdir(), 'helix-m1-web-hello-'));
cpSync(FIXTURE, dir, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Helix Eval');
git('config', 'user.email', 'eval@helix.local');
git('add', '-A');
git('commit', '-q', '-m', 'fixture: web-hello');

const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-eval-m1-')), mcp: false });
if (!engine.vault.isConfigured(values.provider!)) {
  console.error(`provider ${values.provider} has no API key in the environment`);
  process.exit(2);
}

const gates: unknown[] = [];
engine.bus.subscribe('verify.gate', (e) => { gates.push(e.data); });
const started = Date.now();
const task = engine.runtime.create({
  workspacePath: dir,
  goal: 'Change the page heading to "Hello Helix". Install the project dependencies first, start the dev server, make the edit, and confirm the new heading with a screenshot of the running page.',
  provider: values.provider, model: values.model, verifyCommand: 'npm test', policyProfile: 'headless', preapprove: ['all'], maxSteps: 25, budgetUsd: 1,
});
const done = await engine.runtime.wait(task.id, 600_000);

type Part = { type: string; name?: string; args?: { command?: string }; content?: string };
const parts = engine.runtime.transcript(task.id).flatMap((m) => m.parts as Part[]);
const shellCommands = parts.filter((p) => p.type === 'tool_call' && p.name === 'run_shell').map((p) => p.args?.command ?? '');
const toolsUsed = [...new Set(parts.filter((p) => p.type === 'tool_call').map((p) => p.name))];
const shots = parts.filter((p) => p.type === 'tool_result' && p.name === 'preview_screenshot' && p.content?.startsWith('screenshot saved:'));
const screenshots = parts.filter((p) => p.type === 'tool_result' && p.name === 'preview_screenshot').map((p) => p.content!.slice(0, 400));
const confirmingShot = [...shots].reverse().find((p) => /Hello Helix/.test(p.content!));
const shotPath = confirmingShot?.content!.match(/^screenshot saved: (\S+)/)?.[1];
let artifact: string | null = null;
if (shotPath && existsSync(shotPath)) {
  mkdirSync(RESULTS, { recursive: true });
  artifact = `evals/results/m1-demo-${stamp}.png`;
  copyFileSync(shotPath, fileURLToPath(new URL(`../${artifact}`, import.meta.url)));
}

let commit: { sha: string; log: string; files: string[] } | null = null;
let commitError: string | null = null;
try {
  // Same RPC handlers the workbench Git tab calls, over an in-process stream pair instead of a WebSocket.
  const toEngine = new PassThrough();
  const toClient = new PassThrough();
  engine.attach(new RpcPeer(streamTransport(toEngine, toClient)));
  const peer = new RpcPeer(streamTransport(toClient, toEngine));
  await peer.request(Methods.initialize, { clientName: 'm1-demo', clientVersion: '0', protocolVersion: PROTOCOL_VERSION });
  await peer.request(Methods.gitStageAll, { workspacePath: dir });
  const c = await peer.request(Methods.gitCommit, { workspacePath: dir, message: 'Change heading to Hello Helix' }) as { sha: string };
  commit = { sha: c.sha, log: git('log', '--oneline', '-1'), files: git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean) };
  toEngine.end();
  toClient.end();
} catch (e) {
  commitError = (e as Error).message;
}

const page = readFileSync(join(dir, 'src/page.js'), 'utf8');
const checks = {
  taskDone: done.status === 'done',
  depsInstalledViaProxy: shellCommands.some((c) => /\bnpm (install|i|ci)\b/.test(c)) && existsSync(join(dir, 'node_modules/escape-html/package.json')),
  devServerStarted: toolsUsed.includes('start_dev_server'),
  headingEdited: /HEADING = ['"`]Hello Helix['"`]/.test(page),
  screenshotConfirms: Boolean(confirmingShot && artifact),
  gatesPassed: done.status === 'done' && gates.length > 0 && gates.every((g) => (g as { passed?: boolean }).passed !== false),
  committedFromGitPanel: Boolean(commit && commit.log.endsWith('Change heading to Hello Helix') && commit.files.includes('src/page.js') && !commit.files.some((f) => f.startsWith('node_modules/'))),
};
await engine.close();

const pass = Object.values(checks).every(Boolean);
const result = {
  at: new Date().toISOString(), pass, provider: values.provider, model: done.model, status: done.status, steps: done.stepCount, verifyAttempts: done.verifyAttempts,
  seconds: Math.round((Date.now() - started) / 1000), checks, toolsUsed, shellCommands, screenshots, gates, commit, commitError, artifact,
  ledger: { calls: done.ledger.calls, inputTokens: done.ledger.inputTokens, outputTokens: done.ledger.outputTokens, costUsd: done.ledger.costUsd },
  error: done.error ?? null,
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, `m1-demo-${values.provider}-${stamp}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(pass ? 'M1 DEMO: PASS' : 'M1 DEMO: FAIL');
process.exit(pass ? 0 : 1);
