import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'helix-graph-'));
  for (const d of ['src', 'test']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'src/money.ts'), "import { round } from 'lodash';\nexport function toCents(x: number): number {\n  return round(x * 100);\n}\nexport function format(x: number): string {\n  return String(toCents(x));\n}\n");
  writeFileSync(join(dir, 'src/cart.ts'), "import { toCents } from './money';\nexport function total(items: number[]): number {\n  return items.reduce((s, i) => s + toCents(i), 0);\n}\n");
  writeFileSync(join(dir, 'src/checkout.ts'), "import { total } from './cart';\nexport function pay(items: number[]) {\n  return total(items);\n}\n");
  writeFileSync(join(dir, 'src/unrelated.ts'), "import { round } from 'lodash';\nexport function noop() {\n  return round(1);\n}\n");
  writeFileSync(join(dir, 'test/money.test.ts'), "import { toCents } from '../src/money';\nimport { test } from 'node:test';\ntest('cents', () => { toCents(1); });\n");
  writeFileSync(join(dir, 'test/checkout.test.ts'), "import { pay } from '../src/checkout';\nimport { test } from 'node:test';\ntest('pay', () => { pay([1]); });\n");
  const idx = new WorkspaceIndex(new Db(':memory:'), 'ws', dir);
  idx.update();
  return idx;
}

const paths = (r: { items: Array<{ path: string }> }) => [...new Set(r.items.map((i) => i.path))].sort();

test('graph.query: callers of X (direct and transitive)', () => {
  const idx = fixture();
  const direct = idx.graphQuery({ op: 'callers', target: 'toCents' });
  assert.deepEqual(direct.items.filter((i) => i.symbol).map((i) => `${i.path}:${i.symbol}`).sort(), ['src/cart.ts:total', 'src/money.ts:format']);
  assert.deepEqual(paths(direct), ['src/cart.ts', 'src/money.ts', 'test/money.test.ts']);
  const deep = idx.graphQuery({ op: 'callers', target: 'toCents', depth: 3 });
  assert.deepEqual(paths(deep), ['src/cart.ts', 'src/checkout.ts', 'src/money.ts', 'test/checkout.test.ts', 'test/money.test.ts']);
});

test('graph.query: tests covering F (file) and S (symbol)', () => {
  const idx = fixture();
  assert.deepEqual(paths(idx.graphQuery({ op: 'tests', target: 'src/money.ts' })), ['test/money.test.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'tests', target: 'src/checkout.ts' })), ['test/checkout.test.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'tests', target: 'pay' })), ['test/checkout.test.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'tests', target: 'src/unrelated.ts' })), []);
});

test('graph.query: files importing M (module specifier or file)', () => {
  const idx = fixture();
  assert.deepEqual(paths(idx.graphQuery({ op: 'importers', target: 'lodash' })), ['src/money.ts', 'src/unrelated.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'importers', target: 'src/money.ts' })), ['src/cart.ts', 'test/money.test.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'importers', target: 'src/checkout.ts' })), ['test/checkout.test.ts']);
});

test('graph.query: dependents closure, callees, definitions, references', () => {
  const idx = fixture();
  assert.deepEqual(paths(idx.graphQuery({ op: 'dependents', target: 'src/money.ts', depth: 1 })), ['src/cart.ts', 'test/money.test.ts']);
  assert.deepEqual(paths(idx.graphQuery({ op: 'dependents', target: 'src/money.ts', depth: 3 })), ['src/cart.ts', 'src/checkout.ts', 'test/checkout.test.ts', 'test/money.test.ts']);
  assert.deepEqual(idx.graphQuery({ op: 'callees', target: 'total' }).items.map((i) => i.symbol), ['toCents']);
  assert.deepEqual(idx.graphQuery({ op: 'definitions', target: 'pay' }).items.map((i) => `${i.path}:${i.line}`), ['src/checkout.ts:2']);
  assert.ok(idx.graphQuery({ op: 'references', target: 'toCents' }).items.length >= 3);
});
