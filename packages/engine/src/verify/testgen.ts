import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LocalSandbox } from '../sandbox/sandbox.ts';

/**
 * Test generation guard (F-TST-2, §9.6): a proposed test must pass against the current code, and a
 * mutation smoke check (flip one operator / return value in a scratch copy of the target) must make it
 * fail. Tests that survive every mutant are rejected as vacuous.
 */

const FLIPS: Array<[RegExp, string]> = [
  [/ === /, ' !== '], [/ !== /, ' === '], [/ == /, ' != '], [/ != /, ' == '],
  [/ <= /, ' > '], [/ >= /, ' < '], [/ < /, ' >= '], [/ > /, ' <= '],
  [/ \+ /, ' - '], [/ - /, ' + '], [/ \* /, ' / '], [/ \/ /, ' * '],
  [/ && /, ' || '], [/ \|\| /, ' && '],
  [/\breturn true\b/, 'return false'], [/\breturn false\b/, 'return true'],
];

export interface Mutant { line: number; from: string; to: string; source: string }

/** One mutant per flippable operator occurrence within lines [start, end] (1-based), comment lines skipped. */
export function mutants(source: string, range?: { start: number; end: number }, max = 8): Mutant[] {
  const lines = source.split('\n');
  const out: Mutant[] = [];
  const start = Math.max(1, range?.start ?? 1);
  const end = Math.min(lines.length, range?.end ?? lines.length);
  for (let n = start; n <= end && out.length < max; n++) {
    const text = lines[n - 1];
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('import ')) continue;
    for (const [re, to] of FLIPS) {
      if (out.length >= max) break;
      const m = re.exec(text);
      if (!m) continue;
      const mutated = text.slice(0, m.index) + to + text.slice(m.index + m[0].length);
      out.push({ line: n, from: m[0].trim(), to: to.trim(), source: [...lines.slice(0, n - 1), mutated, ...lines.slice(n)].join('\n') });
    }
  }
  return out;
}

export interface SmokeResult {
  accepted: boolean;
  reason: string;
  baseline: { exitCode: number | null; output: string };
  mutants: Array<{ line: number; from: string; to: string; killed: boolean }>;
}

function copyWorkspace(root: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(root)) {
    if (name === '.git' || name === '.helix') continue;
    if (name === 'node_modules') symlinkSync(join(root, name), join(dest, name));
    else cpSync(join(root, name), join(dest, name), { recursive: true, filter: (src) => !/[/\\]node_modules([/\\]|$)/.test(src.slice(root.length)) });
  }
}

/** Run the proposed test in a scratch copy of the workspace (inside `.helix/scratch`), then against each mutant. */
export async function smokeCheck(sandbox: LocalSandbox, input: { testPath: string; testContent: string; targetPath: string; range?: { start: number; end: number }; command: string; signal?: AbortSignal }): Promise<SmokeResult> {
  const rel = `.helix/scratch/tg-${randomBytes(4).toString('hex')}`;
  const scratch = join(sandbox.root, rel);
  mkdirSync(dirname(scratch), { recursive: true });
  try {
    copyWorkspace(sandbox.root, scratch);
    mkdirSync(dirname(join(scratch, input.testPath)), { recursive: true });
    writeFileSync(join(scratch, input.testPath), input.testContent);
    const run = () => sandbox.exec(input.command, { cwd: rel, timeoutMs: 120_000, signal: input.signal });
    const base = await run();
    const baseline = { exitCode: base.exitCode, output: `${base.stdout}\n${base.stderr}`.trim().slice(-2000) };
    if (base.exitCode !== 0) return { accepted: false, reason: `the test does not pass against the current code (exit ${base.exitCode})`, baseline, mutants: [] };
    const original = readFileSync(join(scratch, input.targetPath), 'utf8');
    const list = mutants(original, input.range);
    if (!list.length) return { accepted: false, reason: `no mutable operators found in ${input.targetPath}${input.range ? ` lines ${input.range.start}-${input.range.end}` : ''}`, baseline, mutants: [] };
    const results: SmokeResult['mutants'] = [];
    for (const m of list) {
      writeFileSync(join(scratch, input.targetPath), m.source);
      const r = await run();
      results.push({ line: m.line, from: m.from, to: m.to, killed: r.exitCode !== 0 });
    }
    const killed = results.filter((r) => r.killed).length;
    return {
      accepted: killed > 0, baseline, mutants: results,
      reason: killed > 0 ? `${killed}/${results.length} mutants killed` : `vacuous: the test still passes with all ${results.length} mutants of ${input.targetPath}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
