import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScope } from './check-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/check-scope.mjs');
const roadmap = readFileSync(join(root, 'docs/roadmap.md'), 'utf8');
const plan = readFileSync(join(root, 'plan.md'), 'utf8');
const git = (file) => execFileSync('git', ['show', `refs/remotes/origin/main:${file}`], { cwd: root, encoding: 'utf8' });
const baselinePlan = execFileSync('git', ['show', 'f4742348efe912d2188dbc28a260aca32d391577:plan.md'], { cwd: root, encoding: 'utf8' });
const base = { roadmap, plan, baselinePlan, mainRoadmap: git('docs/roadmap.md'), mainPlan: git('plan.md') };

test('R0.9 real repository has exactly the authoritative 154 IDs and valid evidence', () => {
  const result = checkScope(base);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary, '154/154 IDs, 0 undefined task refs, 0 ticks without evidence, 0 removed items');
});

for (const [name, mutate] of [
  ['deleted requirement row', (text) => text.replace(/^\| FR-1 \|.*\n/m, '')],
  ['removed roadmap task', (text) => text.replace(/^- \[x\] Monorepo.*\n/m, '')],
  ['removed Evidence line', (text) => text.replace(/^  - Evidence:.*\n/m, '')],
  ['undefined task reference', (text) => text.replace('| R0.4 |', '| R99.999 |')],
  ['Done without evidence', (text) => text.replace(/(\| FR-34 \|[^\n]*\| )Evidence:[^\n]*/, '$1— |')],
  ['later milestone task', (text) => text.replace('| R0.4 |', '| R1.1 |')],
  ['duplicate requirement', (text) => `${text}\n${text.split('\n').find((line) => line.startsWith('| FR-1 |'))}\n`],
  ['postponed requirement', (text) => text.replace('| FR-31 | M0 |', '| FR-31 | M1 |')],
]) {
  test(`R0.9 scratch copy: ${name} exits 1`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'helix-scope-'));
    try {
      mkdirSync(join(scratch, 'docs'));
      cpSync(join(root, 'plan.md'), join(scratch, 'plan.md'));
      writeFileSync(join(scratch, 'docs/roadmap.md'), mutate(roadmap));
      const result = spawnSync(process.execPath, [script, '--root', scratch], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.trim().length > 0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}

test('R0.9 missing split-row M0 evidence fails the milestone gate', () => {
  const result = checkScope({ ...base, roadmap: roadmap.replace('M0 part: Evidence:', 'M0 part: unverified:'), milestone: 'M0' });
  assert.ok(result.errors.some((e) => e.includes('missing M0 part: Evidence:')));
});

test('R0.9 rejected verdicts cannot be silently reversed', () => {
  const result = checkScope({ ...base, plan: plan.replace(/(\| X19 \|)[^\n]*/, '$1 reversed |') });
  assert.ok(result.errors.some((e) => e.includes('X19')));
});
