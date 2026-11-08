import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import type { PlanImpactReport } from '../src/index/index.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

function repo(): string {
  const d = tmp('helix-plan-impact-');
  mkdirSync(join(d, 'src'));
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/price.ts'), `export function applyDiscount(total: number, pct: number): number {\n  return total - total * pct;\n}\n`);
  writeFileSync(join(d, 'src/cart.ts'), `import { applyDiscount } from './price.ts';\nexport class Cart {\n  items: number[] = [];\n  checkout(pct: number): number {\n    return applyDiscount(this.items.reduce((a, b) => a + b, 0), pct);\n  }\n}\n`);
  writeFileSync(join(d, 'src/api.ts'), `import { Cart } from './cart.ts';\nexport function handleCheckout(): number {\n  return new Cart().checkout(0.1);\n}\n`);
  writeFileSync(join(d, 'src/tax.ts'), `export function tax(n: number): number {\n  return n * 0.2;\n}\n`);
  writeFileSync(join(d, 'test/cart.test.ts'), `import { Cart } from '../src/cart.ts';\nnew Cart().checkout(0);\n`);
  return d;
}

test('plan mode: submit_plan attaches a linked Impact Report artifact (§11.5)', async () => {
  const dir = repo();
  const plan = {
    goal: 'cap discounts at 50%',
    affectedFiles: [{ path: 'src/price.ts', reason: 'applyDiscount computes the discount', evidence: 'price.ts:1 applyDiscount' }, { path: 'src/tax.ts', reason: 'reuse rounding' }],
    steps: [{ id: 's1', description: 'clamp pct to 0.5 in applyDiscount', writeSet: ['src/price.ts'] }],
    verification: ['node --test'],
  };
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'submit_plan', args: plan }], usage: { input: 400, output: 60 } },
    { text: 'Plan: clamp pct.', usage: { input: 500, output: 10 } },
  ];
  let planToolResult = '';
  const fake = await startFakeProvider('gemini', (ctx) => {
    const body = JSON.stringify(ctx.request.body);
    const m = body.match(/plan saved as [^"]*/);
    if (m) planToolResult = m[0];
    return scripted(turns)(ctx);
  });
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false });
  try {
    const created = engine.runtime.create({ workspacePath: dir, goal: 'plan the discount cap', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'plan' });
    const done = await engine.runtime.wait(created.id, 30_000);
    assert.equal(done.status, 'done', done.error ?? '');

    const plans = engine.runtime.artifacts(created.id, 'plan');
    assert.equal(plans.length, 1);
    const impactId = (plans[0].data as { impactArtifactId?: string }).impactArtifactId;
    assert.ok(impactId, 'plan links its impact report');
    const impacts = engine.runtime.artifacts(created.id, 'impact');
    assert.equal(impacts.length, 1);
    assert.equal(impacts[0].id, impactId);

    const r = impacts[0].data as PlanImpactReport;
    assert.deepEqual(r.changedFiles, ['src/price.ts', 'src/tax.ts']);
    assert.deepEqual(r.changedSymbols, ['applyDiscount (src/price.ts)', 'tax (src/tax.ts)']);
    assert.deepEqual(r.directDependents, ['src/cart.ts']);
    assert.deepEqual(r.transitiveDependents, { depth: 2, count: 2, top: ['src/cart.ts', 'src/api.ts'] });
    assert.deepEqual(r.coveringTests, ['test/cart.test.ts']);
    assert.deepEqual(r.uncoveredChangedFiles, ['src/tax.ts']);
    assert.deepEqual(r.dependentsNotInPlan, ['src/cart.ts', 'src/api.ts']);
    assert.deepEqual(r.riskTerms.map((t) => [t.term, t.value, t.weight, t.contribution]), [
      ['log2(1+dependents)', 1.58, 1, 1.58],
      ['publicApiChange', 1, 1, 1],
      ['uncoveredRatio', 0.5, 2, 1],
    ]);
    assert.equal(r.riskScore, 3.58);
    assert.match(planToolResult, /Impact Report .*risk 3\.58/);
    assert.match(planToolResult, /dependents not in the plan: src\/cart\.ts, src\/api\.ts/);
  } finally {
    await engine.close();
    await fake.close();
  }
});
