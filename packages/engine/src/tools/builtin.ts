import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolRegistry, type PreviewCapture, type Tool } from './registry.ts';
import { codeSearch, domainMap, findSymbol, impactTool } from './index-tools.ts';
import { formatSnapshot } from '../preview/browser.ts';
import { smokeCheck } from '../verify/testgen.ts';
import { loadSkills, skillBody } from '../agent/skills.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'target']);

const readFile: Tool = {
  spec: {
    name: 'read_file',
    description: 'Read a UTF-8 text file in the workspace. Returns numbered lines. Use startLine/endLine (1-based, inclusive) for large files.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'] },
  },
  async run(args, { sandbox }) {
    const abs = sandbox.resolvePath(String(args.path));
    if (!existsSync(abs)) return { content: `file not found: ${args.path}`, isError: true };
    if (statSync(abs).isDirectory()) return { content: `${args.path} is a directory; use list_dir`, isError: true };
    const lines = readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, Number(args.startLine ?? 1));
    const end = Math.min(lines.length, Number(args.endLine ?? lines.length));
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
    return { content: `${sandbox.relative(abs)} (lines ${start}-${end} of ${lines.length})\n${body}`, summary: `read ${sandbox.relative(abs)}` };
  },
};

const listDir: Tool = {
  spec: {
    name: 'list_dir',
    description: 'List files and directories (skips node_modules, .git, build output). Directories end with /.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 5 } } },
  },
  async run(args, { sandbox }) {
    const root = sandbox.resolvePath(String(args.path ?? '.'));
    const depth = Number(args.depth ?? 2);
    const out: string[] = [];
    const walk = (dir: string, level: number) => {
      if (out.length > 500) return;
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        out.push(`${'  '.repeat(level)}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && level + 1 < depth) walk(p, level + 1);
      }
    };
    walk(root, 0);
    return { content: out.join('\n') || '(empty)', summary: `listed ${sandbox.relative(root)}` };
  },
};

const search: Tool = {
  spec: {
    name: 'search',
    description: 'Exact (fixed-string) search across workspace files. Returns path:line:text matches.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, path: { type: 'string' }, glob: { type: 'string', description: 'e.g. *.ts' } }, required: ['pattern'] },
  },
  async run(args, { sandbox, signal }) {
    const root = sandbox.resolvePath(String(args.path ?? '.'));
    const rgArgs = ['--fixed-strings', '--line-number', '--no-heading', '--color=never', '--max-count=50', '--max-columns=300'];
    if (args.glob) rgArgs.push('--glob', String(args.glob));
    rgArgs.push('--', String(args.pattern), '.');
    const text = await new Promise<string>((resolve) => {
      const child = spawn('rg', rgArgs, { cwd: root, signal, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.on('data', (c: Buffer) => { if (buf.length < 100_000) buf += c.toString('utf8'); });
      child.on('close', () => resolve(buf));
      child.on('error', () => resolve(jsSearch(root, String(args.pattern))));
    });
    const lines = text.split('\n').filter(Boolean).slice(0, 200);
    return { content: lines.length ? lines.join('\n') : 'no matches', summary: `search '${args.pattern}': ${lines.length} matches` };
  },
};

function jsSearch(root: string, pattern: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || out.length >= 200) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 1_000_000) readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (l.includes(pattern)) out.push(`${p.slice(root.length + 1)}:${i + 1}:${l.slice(0, 300)}`); });
    }
  };
  walk(root);
  return out.join('\n');
}

function writeWithCheckpoint(abs: string, content: string, beforeWrite?: (p: string, prev: string | null) => void): void {
  beforeWrite?.(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const writeFile: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a file with the full content. Prefer edit_file for small changes to existing files.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  async run(args, { sandbox, beforeWrite }) {
    const abs = sandbox.resolvePath(String(args.path), 'write');
    writeWithCheckpoint(abs, String(args.content), beforeWrite);
    return { content: `wrote ${sandbox.relative(abs)} (${String(args.content).split('\n').length} lines)`, summary: `wrote ${sandbox.relative(abs)}` };
  },
};

const editFile: Tool = {
  spec: {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Include enough context to be unique.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] },
  },
  async run(args, { sandbox, beforeWrite }) {
    const abs = sandbox.resolvePath(String(args.path), 'write');
    if (!existsSync(abs)) return { content: `file not found: ${args.path}`, isError: true };
    const text = readFileSync(abs, 'utf8');
    const oldS = String(args.old_string);
    const count = text.split(oldS).length - 1;
    if (count === 0) return { content: `old_string not found in ${args.path}. Re-read the file and copy the exact text (including whitespace).`, isError: true };
    if (count > 1 && !args.replace_all) return { content: `old_string matches ${count} times in ${args.path}; add surrounding context or set replace_all`, isError: true };
    const next = args.replace_all ? text.split(oldS).join(String(args.new_string)) : text.replace(oldS, () => String(args.new_string));
    writeWithCheckpoint(abs, next, beforeWrite);
    return { content: `edited ${sandbox.relative(abs)} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`, summary: `edited ${sandbox.relative(abs)}` };
  },
};

const runShell: Tool = {
  spec: {
    name: 'run_shell',
    description: 'Run a bash command in the workspace sandbox (network only to allowlisted hosts such as registry.npmjs.org, via the Helix proxy). Returns exit code, stdout, and stderr. Use it to run tests.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1 }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600_000 } }, required: ['command'] },
  },
  async run(args, { sandbox, signal }) {
    const r = await sandbox.exec(String(args.command), { cwd: args.cwd ? String(args.cwd) : undefined, timeoutMs: Number(args.timeoutMs ?? 120_000), signal });
    const status = r.timedOut ? `timed out after ${args.timeoutMs ?? 120_000}ms` : `exit code ${r.exitCode ?? r.signal}`;
    return {
      content: `${status}${r.truncated ? ' (output truncated)' : ''}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      isError: r.exitCode !== 0,
      summary: `$ ${String(args.command).slice(0, 80)} → ${status}`,
    };
  },
};

/** Dev server start (F-PRV-1, §17.2). The server keeps running after the call; its URL is on the host loopback. */
const startDevServerTool: Tool = {
  spec: {
    name: 'start_dev_server',
    description: 'Start the workspace web dev server (package.json "dev" or "start" script) in the sandbox, or reuse the running one. Returns its preview URL once it answers HTTP. Install dependencies first with run_shell.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_args, { startDevServer }) {
    if (!startDevServer) return { content: 'dev servers are not available in this context', isError: true, summary: 'start_dev_server unavailable' };
    try {
      const s = await startDevServer();
      return { content: `dev server running: ${s.url} (command: ${s.command}, sandbox port ${s.port})`, summary: `dev server → ${s.url}` };
    } catch (e) {
      return { content: `dev server failed: ${(e as Error).message}`, isError: true, summary: 'dev server failed' };
    }
  },
};

const previewPathSchema = { type: 'object', properties: { path: { type: 'string', description: 'Page path on the dev server, e.g. "/" or "/about" (default "/")' } }, additionalProperties: false } as const;

function formatConsole(entries: PreviewCapture['console']): string {
  if (!entries.length) return '(no console messages)';
  return entries.slice(0, 50).map((e) => `[${e.level}${e.count > 1 ? ` ×${e.count}` : ''}] ${e.text}${e.url ? ` (${e.url}${e.line !== undefined ? `:${e.line + 1}` : ''})` : ''}`).join('\n');
}

/** Browser tools, minimal (F-PRV-5, §18.5): headless Chrome against the running dev server. */
const previewScreenshot: Tool = {
  spec: {
    name: 'preview_screenshot',
    description: 'Load a page of the running dev server in a headless browser and take a screenshot. Returns the PNG path, page title, visible text excerpt and console errors. Start the server with start_dev_server first.',
    inputSchema: previewPathSchema,
  },
  async run(args, { previewBrowser }) {
    if (!previewBrowser) return { content: 'browser tools are not available in this context', isError: true, summary: 'preview_screenshot unavailable' };
    try {
      const s = await previewBrowser.screenshot((args as { path?: string }).path);
      const errors = s.console.filter((e) => e.level === 'error');
      return {
        content: `screenshot saved: ${s.path} (${s.bytes} bytes)\nurl: ${s.url}\ntitle: ${s.title}\nload: ${s.status}\nvisible text:\n${s.text.slice(0, 1500)}\nconsole errors:\n${formatConsole(errors)}`,
        summary: `screenshot ${s.url} · ${errors.length} console error(s)`,
      };
    } catch (e) {
      return { content: `screenshot failed: ${(e as Error).message}`, isError: true, summary: 'preview_screenshot failed' };
    }
  },
};

const previewSnapshot: Tool = {
  spec: {
    name: 'preview_snapshot',
    description: 'Environment Snapshot of a dev-server page: pruned accessibility tree with stable refs (@e…), console errors (deduplicated), and failed/slow network requests. Repeat calls on the same page return only what changed (added/removed/changed refs); pass full: true for the whole tree. Cheaper than a screenshot for checking UI state.',
    inputSchema: { type: 'object', properties: { ...previewPathSchema.properties, full: { type: 'boolean', description: 'Return the full tree instead of a diff' } } },
  },
  async run(args, { previewBrowser }) {
    if (!previewBrowser) return { content: 'browser tools are not available in this context', isError: true, summary: 'preview_snapshot unavailable' };
    try {
      const s = await previewBrowser.snapshot((args as { path?: string }).path);
      return { content: formatSnapshot(s, { full: Boolean(args.full) }), summary: `snapshot #${s.seq} ${s.page.url} · ${s.console.newErrors.length} error(s) · ${s.network.failed.length} failed request(s)${s.diff ? ` · diff +${s.diff.added.length}/-${s.diff.removed.length}/~${s.diff.changed.length}` : ''}` };
    } catch (e) {
      return { content: `snapshot failed: ${(e as Error).message}`, isError: true, summary: 'preview_snapshot failed' };
    }
  },
};
const previewConsole: Tool = {
  spec: {
    name: 'preview_console',
    description: 'Load a page of the running dev server in a headless browser and return its console messages and uncaught exceptions. Start the server with start_dev_server first.',
    inputSchema: previewPathSchema,
  },
  async run(args, { previewBrowser }) {
    if (!previewBrowser) return { content: 'browser tools are not available in this context', isError: true, summary: 'preview_console unavailable' };
    try {
      const c = await previewBrowser.console((args as { path?: string }).path);
      const errors = c.console.filter((e) => e.level === 'error').length;
      const failed = c.network.filter((n) => n.failed || (n.status ?? 0) >= 400);
      return { content: `url: ${c.url}\nload: ${c.status}\nconsole:\n${formatConsole(c.console)}\nnetwork: ${c.network.length} request(s), ${failed.length} failed, ${c.pending} pending${failed.map((n) => `\n  ${n.method} ${n.url} → ${n.failed ?? n.status}`).join('')}`, summary: `console ${c.url} · ${c.console.length} message(s), ${errors} error(s)` };
    } catch (e) {
      return { content: `console capture failed: ${(e as Error).message}`, isError: true, summary: 'preview_console failed' };
    }
  },
};

/** Explore subagent (F-ORC-1, §10.2): a read-only sub-loop that answers a codebase question with a short summary. */
const exploreTool: Tool = {
  spec: {
    name: 'explore',
    description: 'Delegate a codebase question to a read-only explore subagent (find_symbol, code_search, read_file). Returns a short summary with path:line evidence. Use it for open-ended "where/how is X done" questions to keep your own context small.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'The specific question to answer about the codebase' } }, required: ['question'], additionalProperties: false },
  },
  async run(args, { explore }) {
    const question = String((args as { question?: unknown }).question ?? '').trim();
    if (!question) return { content: 'question is required', isError: true };
    if (!explore) return { content: 'the explore subagent is not available in this context', isError: true, summary: 'explore unavailable' };
    try {
      const summary = await explore(question);
      return { content: summary, summary: `explore → ${summary.length} chars` };
    } catch (e) {
      return { content: `explore failed: ${(e as Error).message}`, isError: true, summary: 'explore failed' };
    }
  },
};

/** Test generation (F-TST-2, §9.6): keep a proposed test only if it passes and a mutation smoke check kills it. */
const proposeTest: Tool = {
  spec: {
    name: 'propose_test',
    description: 'Propose a new unit test for a changed or uncovered symbol. Helix runs it in a scratch copy: it must pass on the current code and fail when an operator or return value in the target is flipped (mutation smoke check). Only then is the test file written. Returns the verdict and mutant results.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Test file to create, e.g. test/divide.test.js' },
        content: { type: 'string', description: 'Full test file content' },
        target: { type: 'string', description: 'Source file under test (mutated in the scratch copy)' },
        symbol: { type: 'string', description: 'Function/method under test; limits mutations to its lines' },
        command: { type: 'string', description: 'Command that runs just this test (default: node --test <path>)' },
      },
      required: ['path', 'content', 'target'],
      additionalProperties: false,
    },
  },
  async run(args, { sandbox, signal, index, beforeWrite }) {
    const path = sandbox.relative(sandbox.resolvePath(String(args.path), 'write'));
    const target = sandbox.relative(sandbox.resolvePath(String(args.target)));
    if (existsSync(sandbox.resolvePath(path))) return { content: `${path} already exists; propose a new test file`, isError: true };
    if (!existsSync(sandbox.resolvePath(target))) return { content: `target not found: ${target}`, isError: true };
    let range: { start: number; end: number } | undefined;
    if (args.symbol && index) {
      index.update();
      const hit = index.findSymbol(String(args.symbol)).find((s) => s.path === target && (s.name === args.symbol || s.qualifiedName === args.symbol));
      if (!hit) return { content: `symbol '${args.symbol}' not found in ${target}`, isError: true };
      range = { start: hit.line, end: hit.endLine };
    }
    const command = args.command ? String(args.command) : `node --test ${JSON.stringify(path)}`;
    const r = await smokeCheck(sandbox, { testPath: path, testContent: String(args.content), targetPath: target, range, command, signal });
    const table = r.mutants.map((m) => `  ${target}:${m.line} '${m.from}'→'${m.to}': ${m.killed ? 'killed' : 'survived'}`).join('\n');
    if (r.accepted) writeWithCheckpoint(sandbox.resolvePath(path, 'write'), String(args.content), beforeWrite);
    return {
      content: `${r.accepted ? `ACCEPTED: wrote ${path}` : `REJECTED: ${path} not written`} — ${r.reason}${table ? `\nmutants:\n${table}` : ''}${r.accepted ? '' : `\ntest output (tail):\n${r.baseline.output}`}`,
      isError: !r.accepted,
      summary: `propose_test ${path}: ${r.accepted ? 'accepted' : 'rejected'} (${r.reason})`,
    };
  },
};

/** Skills (F-AGT-5, §9.7): the context lists only name + description; the body loads here. */
const useSkill: Tool = {
  spec: {
    name: 'use_skill',
    description: 'Load the full instructions of a workspace skill listed under "Skills" in your context (skills/<name>/SKILL.md). Returns its body and any helper scripts.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
  },
  async run(args, { sandbox }) {
    const r = skillBody(sandbox.root, String(args.name));
    if (!r) return { content: `unknown skill '${args.name}'. Available: ${loadSkills(sandbox.root).map((s) => s.name).join(', ') || '(none)'}`, isError: true };
    return { content: `# Skill: ${r.skill.name} (${r.skill.file})\n${r.body}${r.scripts.length ? `\n\nScripts (run with run_shell):\n${r.scripts.map((s) => `- ${s}`).join('\n')}` : ''}`, summary: `use_skill ${r.skill.name}` };
  },
};

/** Plan Mode output (F-AGT-2, §9.4). Only offered under the `plan` profile. */
export const submitPlan: Tool = {
  spec: {
    name: 'submit_plan',
    description: 'Submit the final implementation plan (Plan Mode). Call exactly once when the plan is complete. Cite concrete files found with find_symbol/code_search/read_file.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        affectedFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string', description: 'symbol/line/import that proves relevance' } }, required: ['path', 'reason'] } },
        steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' }, writeSet: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['id', 'description'] } },
        risks: { type: 'array', items: { type: 'string' } },
        verification: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['goal', 'affectedFiles', 'steps', 'verification'],
    },
  },
  async run(args, { submitArtifact, sandbox, index }) {
    if (!submitArtifact) return { content: 'submit_plan is only available in Plan Mode', isError: true };
    const files = (args.affectedFiles as Array<{ path: string }>) ?? [];
    const missing = files.filter((f) => { try { sandbox.resolvePath(f.path); return !existsSync(sandbox.resolvePath(f.path)); } catch { return true; } }).map((f) => f.path);
    let impactArtifactId: string | undefined;
    let impactNote = '';
    if (index) {
      index.update();
      const planned = new Set(files.map((f) => f.path));
      const report = index.planImpact(files.map((f) => f.path).filter((p) => !missing.includes(p)));
      report.dependentsNotInPlan = report.dependentsNotInPlan.filter((p) => !planned.has(p));
      impactArtifactId = submitArtifact('impact', 'Impact Report', report);
      impactNote = `\nImpact Report ${impactArtifactId}: risk ${report.riskScore} (${report.riskTerms.map((t) => `${t.term}=${t.value}×${t.weight}`).join(' + ')}); dependents ${report.transitiveDependents.count}; tests ${report.coveringTests.join(', ') || 'none'}${report.dependentsNotInPlan.length ? `; dependents not in the plan: ${report.dependentsNotInPlan.join(', ')}` : ''}`;
    }
    const id = submitArtifact('plan', String(args.goal).slice(0, 120), { ...args, unverifiedPaths: missing, ...(impactArtifactId ? { impactArtifactId } : {}) });
    return { content: `plan saved as ${id}${missing.length ? `; note: these paths do not exist yet (new files?): ${missing.join(', ')}` : ''}.${impactNote}\nNow reply with a one-paragraph summary and stop.`, summary: `plan ${id}: ${(args.steps as unknown[]).length} steps` };
  },
};

export function builtinTools(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of [readFile, listDir, search, findSymbol, codeSearch, impactTool, domainMap, writeFile, editFile, runShell, startDevServerTool, previewScreenshot, previewConsole, previewSnapshot, exploreTool, proposeTest, useSkill, submitPlan]) reg.register(t);
  return reg;
}
