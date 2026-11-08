import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { preciseReferences, typescriptFor } from '../src/index/precise.ts';
import { impactTool } from '../src/tools/index-tools.ts';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'helix-precise-'));
  writeFileSync(join(d, 'a.ts'), `export function format(n: number): string {\n  return n.toFixed(2);\n}\n`);
  writeFileSync(join(d, 'b.ts'), `export function format(s: string): string {\n  return s.trim();\n}\n`);
  writeFileSync(join(d, 'both.ts'), `import { format } from './a';\nimport * as B from './b';\nexport function label(n: number, s: string): string {\n  return format(n) + B.format(s);\n}\n`);
  writeFileSync(join(d, 'alias.ts'), `import { format as money } from './a';\nexport function total(n: number): string {\n  return money(n * 2);\n}\n`);
  return d;
}

const skip = !typescriptFor(process.cwd()) && 'typescript not resolvable';

test('precise references: language service in the sandbox finds the alias and excludes B.format (F-IDX-2)', { skip }, async () => {
  const d = repo();
  const refs = await preciseReferences(d, [{ path: 'a.ts', line: 1, name: 'format' }, { path: 'b.ts', line: 1, name: 'format' }, { path: 'a.ts', line: 2, name: 'nope' }]);
  assert.ok(refs, 'precise tier ran');
  const sites = (i: number) => [...new Set(refs![i]!.filter((r) => !r.isDefinition).map((r) => `${r.path}:${r.line}`))].sort();
  assert.deepEqual(sites(0), ['alias.ts:1', 'alias.ts:3', 'both.ts:1', 'both.ts:4']);
  assert.deepEqual(sites(1), ['both.ts:4']);
  assert.equal(refs![2], null, 'name not on the line → unresolved');
});

test('impact: precise callers replace the name-based heuristic for TS definitions (F-IDX-2)', { skip }, async () => {
  const d = repo();
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'helix-precise-db-')), 'e.sqlite'));
  const idx = new WorkspaceIndex(db, 'ws_p', d);
  idx.update();

  const heuristic = idx.impact('format', { depth: 1 });
  assert.equal(heuristic.precision, 'heuristic');
  const hSites = heuristic.callers.map((c) => `${c.path}:${c.line}`);
  assert.ok(!hSites.includes('alias.ts:3'), 'heuristic misses the aliased call');

  const out = await impactTool.run({ target: 'format' }, { index: idx } as never);
  assert.equal(out.isError, undefined);
  assert.match(out.content, /\(precise, TypeScript language service/);
  const lines = out.content.split('\n').filter((l) => /^\s+\S+:\d+ in /.test(l)).map((l) => l.trim()).sort();
  assert.deepEqual(lines, [
    'alias.ts:1 in (top level) -> format (a.ts:1)',
    'alias.ts:3 in total -> format (a.ts:1)',
    'both.ts:1 in (top level) -> format (a.ts:1)',
    'both.ts:4 in label -> format (a.ts:1)',
    'both.ts:4 in label -> format (b.ts:1)',
  ]);
  assert.notDeepEqual(lines.length, heuristic.callers.length);
  db.close();
});
