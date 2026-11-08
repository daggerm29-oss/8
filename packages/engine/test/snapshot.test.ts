import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, formatSnapshot, PreviewBrowser, type A11yNode } from '../src/preview/browser.ts';

const V1 = `<!doctype html><title>Shop</title><main><h1>Cart</h1>
<label>Coupon <input name="coupon" value="SAVE10"></label>
<button>Checkout</button></main>
<script>for (let i = 0; i < 3; i++) console.error('price service down'); fetch('/api/missing?token=abc123&page=2');</script>`;
const V2 = `<!doctype html><title>Shop</title><main><h1>Cart</h1>
<label>Coupon <input name="coupon" value="SAVE20"></label>
<a href="/help">Need help?</a></main>`;

const flat = (nodes: A11yNode[]): A11yNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

test('environment snapshot: pruned AX tree with stable refs, telemetry, and diff (F-PRV-3/4)', { skip: findChrome() ? false : 'no Chrome/Chromium' }, async () => {
  let page = V1;
  const server = createServer((q, s) => {
    if (q.url?.startsWith('/api/')) { s.statusCode = 404; s.end('nope'); return; }
    s.setHeader('content-type', 'text/html');
    s.end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = new PreviewBrowser({ outDir: mkdtempSync(join(tmpdir(), 'helix-snap-')) });
  try {
    const first = await browser.snapshot(url);
    const nodes = flat(first.ui.tree);
    const find = (role: string, name: RegExp) => nodes.find((n) => n.role === role && name.test(n.name ?? ''));
    const heading = find('heading', /^Cart$/);
    const box = find('textbox', /Coupon/);
    assert.ok(heading && box && find('button', /^Checkout$/) && find('main', /.*/), formatSnapshot(first, { full: true }));
    assert.equal(box.value, 'SAVE10');
    assert.ok(nodes.every((n) => /^@e[0-9a-f]{6}(-\d+)?$/.test(n.ref)));
    assert.equal(first.page.title, 'Shop');
    assert.equal(first.page.viewport.w, 1280);
    assert.equal(first.diff, undefined);

    const priceErrors = first.console.newErrors.filter((e) => /price service down/.test(e.text));
    assert.equal(priceErrors.length, 1, JSON.stringify(first.console.newErrors));
    assert.equal(priceErrors[0].count, 3);
    assert.ok(first.console.newErrors.some((e) => /404/.test(e.text)), 'browser log of the failed resource is captured');
    const failed = first.network.failed.find((n) => n.url.includes('/api/missing'));
    assert.ok(failed, JSON.stringify(first.network));
    assert.equal(failed.status, 404);
    assert.match(failed.url, /token=\[redacted\]&page=2/);
    assert.ok(!formatSnapshot(first).includes('abc123'));

    page = V2;
    const second = await browser.snapshot(url);
    assert.ok(second.diff);
    assert.equal(second.diff.since, first.seq);
    assert.ok(second.diff.removed.some((n) => n.role === 'button' && n.name === 'Checkout'), JSON.stringify(second.diff));
    assert.ok(second.diff.added.some((n) => n.role === 'link' && n.name === 'Need help?'), JSON.stringify(second.diff));
    assert.deepEqual(second.diff.changed.filter((c) => c.field === 'value'), [{ ref: box.ref, field: 'value', from: 'SAVE10', to: 'SAVE20' }]);
    assert.ok(flat(second.ui.tree).some((n) => n.ref === heading.ref), 'heading keeps its ref');
    assert.equal(second.network.failed.length, 0);

    const diffText = formatSnapshot(second);
    const fullText = formatSnapshot(second, { full: true });
    assert.match(diffText, /ui diff since #\d+: 1 added, 1 removed, 1 changed/);
    assert.match(diffText, /~ @e[0-9a-f]+ value: "SAVE10" → "SAVE20"/);
    assert.ok(diffText.length < fullText.length + 200);
  } finally {
    await browser.close();
    server.close();
  }
});
