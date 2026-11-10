import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { extract } from '../src/index/extract.ts';
import { extractRefs } from '../src/index/graph.ts';
import { impactTool } from '../src/tools/index-tools.ts';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'helix-graph-'));
  mkdirSync(join(d, 'src'));
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/price.ts'), `export function applyDiscount(total: number, pct: number): number {
  return total - total * pct; // applyDiscount(x) in a comment is ignored
}
`);
  writeFileSync(join(d, 'src/cart.ts'), `import { applyDiscount } from './price.ts';
export class Cart {
  items: number[] = [];
  checkout(pct: number): number {
    const sum = this.items.reduce((a, b) => a + b, 0);
    return applyDiscount(sum, pct);
  }
}
`);
  writeFileSync(join(d, 'src/api.ts'), `import { Cart } from './cart.ts';
export function handleCheckout(): number {
  const c = new Cart();
  return c.checkout(0.1);
}
`);
  writeFileSync(join(d, 'src/unrelated.ts'), `function applyDiscount() { return 0; }
export const x = applyDiscount();
`);
  writeFileSync(join(d, 'test/cart.test.ts'), `import { Cart } from '../src/cart.ts';
new Cart().checkout(0);
`);
  writeFileSync(join(d, 'tools.py'), `def helper(x):
    return x * 2

def main():
    print(helper(3))  # helper( in comment
`);
  return d;
}

test('graph: call-site extraction skips definitions, comments and strings, and records the enclosing symbol', () => {
  const src = `export function a() {\n  return b('a(') + c();\n}\n// d()\nconst e = new Thing();\n`;
  const refs = extractRefs('ts', src, extract('ts', src).symbols);
  assert.deepEqual(refs.map((r) => `${r.line}:${r.name}:${r.caller}`), ['2:b:a', '2:c:a', '5:Thing:']);
  const py = `def helper(x):\n    return x\n\ndef main():\n    print(helper(3))  # helper(\n`;
  assert.deepEqual(extractRefs('py', py, extract('py', py).symbols).map((r) => `${r.line}:${r.name}:${r.caller}`), ['5:helper:main']);
});

test('graph: impact() walks callers transitively, scopes by imports, and finds covering tests', async () => {
  const dir = repo();
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'helix-graph-db-')), 'e.sqlite'));
  const idx = new WorkspaceIndex(db, 'ws_g', dir);
  idx.update();

  const r = idx.impact('applyDiscount', { depth: 3 });
  assert.equal(r.kind, 'symbol');
  const chain = r.callers.map((c) => `${c.depth}:${c.path}:${c.caller}`);
  assert.ok(chain.includes('1:src/cart.ts:Cart.checkout'), chain.join(' | '));
  assert.ok(chain.includes('2:src/api.ts:handleCheckout'), chain.join(' | '));
  assert.ok(chain.includes('2:test/cart.test.ts:'), chain.join(' | '));
  assert.ok(r.affectedFiles.includes('src/cart.ts') && r.affectedFiles.includes('src/api.ts'));
  assert.ok(r.tests.includes('test/cart.test.ts'));
  // The unrelated file's local applyDiscount is its own definition; its callers are not attributed to price.ts.
  assert.ok(!r.callers.some((c) => c.path === 'src/unrelated.ts' && c.calls === 'applyDiscount' && c.depth === 1 && r.definitions.every((d) => d.path !== 'src/unrelated.ts')));

  const f = idx.impact('src/cart.ts');
  assert.equal(f.kind, 'file');
  assert.ok(f.affectedFiles.includes('src/api.ts'));
  assert.deepEqual(f.tests, ['test/cart.test.ts']);

  assert.equal(idx.impact('doesNotExist').kind, 'unknown');

  const py = idx.impact('helper');
  assert.deepEqual(py.callers.map((c) => `${c.path}:${c.line}:${c.caller}`), ['tools.py:5:main']);

  const out = await impactTool.run({ target: 'applyDiscount' }, { index: idx, sandbox: { isolation: 'strict' } } as never);
  assert.match(out.content, /src\/cart\.ts:6 in Cart\.checkout -> applyDiscount/);
  assert.match(out.summary ?? '', /impact applyDiscount: \d+ callers/);
  db.close();
});
