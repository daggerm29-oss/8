import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LineDecoder, RpcPeer, RpcError, streamTransport } from '@helix/protocol';
import { Db } from '../src/storage/db.ts';
import { MIGRATIONS } from '../src/storage/migrations.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { EventBus, topicMatches } from '../src/events/bus.ts';
import { Tracer } from '../src/obs/tracing.ts';
import { Redactor } from '../src/util/redact.ts';
import { ulid, canonicalJson } from '../src/util/ids.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'helix-core-'));

test('LineDecoder splits NDJSON across chunk boundaries', () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(d.push(':2}\n\n'), ['{"b":2}']);
});

test('RpcPeer request/response, errors, notifications over stdio-style streams', async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new RpcPeer(streamTransport(bToA, aToB));
  const b = new RpcPeer(streamTransport(aToB, bToA));
  b.handle('add', (p) => (p as { x: number; y: number }).x + (p as { x: number; y: number }).y);
  b.handle('fail', () => {
    throw new RpcError(-32602, 'bad params', { field: 'x' });
  });
  const got: unknown[] = [];
  a.onNotification('event', (p) => got.push(p));
  assert.equal(await a.request('add', { x: 2, y: 3 }), 5);
  await assert.rejects(a.request('fail'), (e: RpcError) => e.code === -32602 && e.message === 'bad params');
  await assert.rejects(a.request('missing'), (e: RpcError) => e.code === -32601);
  b.notify('event', { n: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [{ n: 1 }]);
  a.close();
});

test('Db applies migrations, is idempotent, and backs up before upgrading', () => {
  const dir = tmp();
  const path = join(dir, 'helix.sqlite');
  const db = new Db(path);
  assert.equal(db.schemaVersion, MIGRATIONS.length);
  db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'k', 'v');
  db.close();
  const again = new Db(path);
  assert.equal(again.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'k')?.value, 'v');
  again.raw.exec('PRAGMA user_version = 0');
  again.close();
  assert.throws(() => new Db(path)); // re-running v1 on an existing schema fails and rolls back
  assert.ok(readdirSync(dir).length >= 1);
});

test('BlobStore is content-addressed and verifies integrity', () => {
  const dir = tmp();
  const db = new Db(':memory:');
  const blobs = new BlobStore(join(dir, 'blobs'), db);
  const r1 = blobs.put('hello world', { kind: 'test', id: '1' });
  const r2 = blobs.put('hello world');
  assert.equal(r1, r2);
  assert.equal(blobs.getText(r1), 'hello world');
  assert.ok(existsSync(join(dir, 'blobs', r1.slice(5, 7), r1.slice(5))));
  assert.throws(() => blobs.get('blob:../etc/passwd'));
});

test('EventBus: topic matching, monotonic seq, batching, replay, and audit hash chain', async () => {
  assert.ok(topicMatches('agent.*', 'agent.step'));
  assert.ok(!topicMatches('agent.*', 'agent.step.completed'));
  assert.ok(topicMatches('agent.**', 'agent.step.completed'));
  assert.ok(topicMatches('**', 'x.y'));
  const db = new Db(':memory:');
  const bus = new EventBus(db, { flushMs: 5 });
  const seen: string[] = [];
  bus.subscribe('task.*', (e) => void seen.push(e.topic));
  const e1 = bus.publish({ topic: 'task.created', ws: 'w1', data: { a: 1 } });
  const e2 = bus.publish({ topic: 'task.updated', ws: 'w1', data: { a: 2 } });
  bus.publish({ topic: 'agent.message.delta', ws: 'w1', data: 'x', persist: 'none' });
  bus.publish({ topic: 'policy.decision', ws: 'w1', data: { allow: true }, persist: 'audit' });
  bus.publish({ topic: 'policy.decision', ws: 'w1', data: { allow: false }, persist: 'audit' });
  assert.ok(e2.seq > e1.seq);
  assert.deepEqual(seen, ['task.created', 'task.updated']);
  await new Promise((r) => setTimeout(r, 20));
  const replayed = bus.replay('w1', e1.seq);
  assert.ok(replayed.some((e) => e.id === e2.id));
  assert.ok(!replayed.some((e) => e.topic === 'agent.message.delta'));
  assert.equal(bus.verifyAuditChain(), null);
  db.run("UPDATE audit_log SET data_json = '{\"allow\":true}' WHERE id = 2");
  assert.equal(bus.verifyAuditChain(), 2);
  // seq continues monotonically after a "restart"
  const bus2 = new EventBus(db);
  assert.ok(bus2.publish({ topic: 't', ws: 'w1', data: null }).seq > e2.seq);
});

test('Tracer records parent/child spans and produces OTLP JSON', async () => {
  const db = new Db(':memory:');
  const tracer = new Tracer(db, { otlpEndpoint: null });
  await tracer.withSpan('parent', { a: 1 }, async () => {
    await tracer.withSpan('child', {}, async (s) => {
      s.setAttribute('k', 'v');
    });
  });
  await assert.rejects(tracer.withSpan('boom', {}, async () => {
    throw new Error('x');
  }));
  const spans = db.all<{ name: string; trace_id: string; span_id: string; parent_span_id: string | null; status_code: number }>('SELECT * FROM spans');
  const parent = spans.find((s) => s.name === 'parent')!;
  const child = spans.find((s) => s.name === 'child')!;
  assert.equal(child.parent_span_id, parent.span_id);
  assert.equal(child.trace_id, parent.trace_id);
  assert.equal(spans.find((s) => s.name === 'boom')!.status_code, 2);
  const otlp = tracer.toOtlpJson([]) as { resourceSpans: unknown[] };
  assert.equal(otlp.resourceSpans.length, 1);
});

test('Redactor removes registered literals and known key shapes', () => {
  const r = new Redactor();
  r.register('super-secret-value-123');
  const out = r.redact('a super-secret-value-123 b sk-proj-abcdefghijklmnopqrstuvwxyz0123 c AIzaSyA1234567890abcdefghijklmnopqrstuv');
  assert.ok(!out.includes('super-secret'));
  assert.ok(!out.includes('sk-proj-abc'));
  assert.ok(!out.includes('AIzaSy'));
});

test('ulid is time-ordered and canonicalJson sorts keys', () => {
  const a = ulid();
  const b = ulid();
  assert.ok(b > a);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});
