import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
function generate(marker = '') {
  const root = mkdtempSync(join(tmpdir(), 'helix-progress-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'docs'));
    cpSync(join(here, 'progress.mjs'), join(root, 'scripts/progress.mjs'));
    writeFileSync(join(root, 'progress.md'), '<!-- progress:start -->\n<!-- progress:end -->\n');
    writeFileSync(join(root, 'docs/roadmap.md'), `## M0 — Foundations\n- [ ] R0.8 CI pipeline\n${marker}\n## M1 — MVP\n- [x] Existing task\n  - Evidence: retained\n- [ ] R1.1 Electron workbench\n`);
    execFileSync(process.execPath, [join(root, 'scripts/progress.mjs')]);
    return { progress: readFileSync(join(root, 'progress.md'), 'utf8'), roadmap: readFileSync(join(root, 'docs/roadmap.md'), 'utf8') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('without explicit override progress selects the first unfinished milestone', () => {
  assert.match(generate().progress, /Current milestone:\*\* M0/);
});
test('authorized execution marker changes order, never ticks earlier work or alters arithmetic', () => {
  const result = generate('<!-- execution-milestone: M1 -->');
  assert.match(result.progress, /Current milestone:\*\* M1/);
  assert.match(result.progress, /Next task:\*\* R1\.1/);
  assert.match(result.progress, /M0 remains unfinished/);
  assert.match(result.progress, /0\/1 \| Unfinished \(execution postponed\)/);
  assert.match(result.progress, /33%.*1\/3/);
  assert.match(result.roadmap, /- \[ \] R0\.8/);
});
test('unknown execution marker fails instead of silently choosing a milestone', () => {
  assert.throws(() => generate('<!-- execution-milestone: M99 -->'), /Unknown execution milestone/);
});
