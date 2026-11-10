import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, SseParser, parseRetryAfter, parseStructured, streamWithRetry, validateJson, type JsonSchema, type Message, type ModelManifest, type ModelRequest, type ProviderAdapter, type StreamEvent } from '@helix/protocol';
import { GEMINI_MODELS, GeminiAdapter } from '@helix/provider-gemini';
import { OPENAI_MODELS, OpenAIAdapter } from '@helix/provider-openai';
import { startFakeProvider, lastToolResult, type FakeScript } from '../src/index.ts';

type Overlay = (m: ModelManifest) => ModelManifest;
const adapters: Array<{ kind: 'gemini' | 'openai'; make: (overlay?: Overlay) => ProviderAdapter; model: string }> = [
  { kind: 'gemini', make: (o) => new GeminiAdapter(o ? { models: GEMINI_MODELS.map(o) } : {}), model: 'gemini-3.8-flash' },
  { kind: 'openai', make: (o) => new OpenAIAdapter(o ? { models: OPENAI_MODELS.map(o) } : {}), model: 'gpt-5-mini' },
];

/** Strict-compatible schema (all properties required, no additional properties). */
const verdictSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'files'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    files: { type: 'array', items: { type: 'string' } },
  },
};
const notices = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: 'notice' }> => e.type === 'notice');

const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] } }];

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function done(events: StreamEvent[]) {
  const d = events.at(-1);
  assert.equal(d?.type, 'done');
  return d as Extract<StreamEvent, { type: 'done' }>;
}

test('SseParser handles CRLF, multi-line data, comments, and chunk splits', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(': ping\r\nevent: a\r\ndata: 1\r\n'), []);
  const out = p.push('data: 2\r\n\r\ndata: x');
  assert.deepEqual(out, [{ event: 'a', data: '1\n2', id: undefined }]);
  assert.deepEqual(p.end(), [{ event: undefined, data: 'x', id: undefined }]);
});

for (const { kind, make, model } of adapters) {
  test(`[${kind}] streams text and reports provider usage`, async () => {
    const fake = await startFakeProvider(kind, () => ({ text: 'Hello from the fake model', usage: { input: 120, cached: 20, output: 30, reasoning: 10 } }));
    try {
      const events = await collect(make().stream({ model, system: 'be brief', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, { apiKey: fake.apiKey, baseUrl: fake.url }, new AbortController().signal));
      const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
      assert.equal(text, 'Hello from the fake model');
      const d = done(events);
      assert.equal(d.finishReason, 'stop');
      assert.equal(d.usage.source, 'provider');
      assert.deepEqual([d.usage.inputTokens, d.usage.cachedInputTokens, d.usage.outputTokens, d.usage.reasoningTokens], [120, 20, 30, 10]);
      const textPart = d.message.parts.find((p) => p.type === 'text');
      assert.equal(textPart && textPart.type === 'text' ? textPart.text : '', 'Hello from the fake model');
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] tool call round trip preserves ids and provider state`, async () => {
    const script: FakeScript = ({ index, request }) => {
      if (index === 0) return { text: 'Let me look.', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] };
      return { text: `got: ${lastToolResult(request)}` };
    };
    const fake = await startFakeProvider(kind, script);
    try {
      const adapter = make();
      const auth = { apiKey: fake.apiKey, baseUrl: fake.url };
      const messages: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'read both' }] }];
      const first = done(await collect(adapter.stream({ model, messages, tools }, auth, new AbortController().signal)));
      assert.equal(first.finishReason, 'tool_calls');
      const calls = first.message.parts.filter((p) => p.type === 'tool_call');
      assert.equal(calls.length, 2);
      assert.deepEqual((calls[0] as { args: unknown }).args, { path: 'a.txt' });
      messages.push(first.message);
      messages.push({ role: 'tool', parts: calls.map((c) => ({ type: 'tool_result' as const, callId: (c as { id: string }).id, name: 'read_file', content: `contents of ${((c as { args: { path: string } }).args).path}`, provenance: { source: 'repo' as const, trust: 'untrusted' as const, taint: true } })) });
      const second = done(await collect(adapter.stream({ model, messages, tools }, auth, new AbortController().signal)));
      const text = second.message.parts.find((p) => p.type === 'text');
      assert.equal(text && text.type === 'text' ? text.text : '', 'got: contents of b.txt');
      if (kind === 'gemini') {
        const sent = fake.requests.at(-1)!.body.contents[1].parts.filter((p: { functionCall?: unknown }) => p.functionCall);
        assert.deepEqual(sent.map((p: { thoughtSignature: string }) => p.thoughtSignature), ['sig_0_0', 'sig_0_1']);
      } else {
        const input = fake.requests.at(-1)!.body.input;
        assert.ok(input.some((i: { type: string; encrypted_content?: string }) => i.type === 'reasoning' && i.encrypted_content === 'enc_0'));
      }
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] normalizes errors: auth, rate limit, context overflow, transient`, async () => {
    const cases: Array<{ status: number; body: unknown; headers?: Record<string, string>; kind: string }> = kind === 'gemini'
      ? [
        { status: 429, body: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } }, kind: 'rate_limit' },
        { status: 400, body: { error: { code: 400, message: 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }, kind: 'context_overflow' },
        { status: 503, body: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, kind: 'transient' },
      ]
      : [
        { status: 429, body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '7' }, kind: 'rate_limit' },
        { status: 400, body: { error: { message: 'Your input exceeds the context window of this model.', type: 'invalid_request_error', code: 'context_length_exceeded' } }, kind: 'context_overflow' },
        { status: 500, body: { error: { message: 'server error', type: 'server_error', code: null } }, kind: 'transient' },
        { status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, kind: 'plan_limit' },
      ];
    let i = 0;
    const fake = await startFakeProvider(kind, () => ({ error: cases[i] }));
    try {
      const req: ModelRequest = { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] };
      for (; i < cases.length; i++) {
        await assert.rejects(collect(make().stream(req, { apiKey: fake.apiKey, baseUrl: fake.url }, new AbortController().signal)), (e: ProviderError) => {
          assert.ok(e instanceof ProviderError, String(e));
          assert.equal(e.kind, cases[i].kind, e.message);
          if (e.kind === 'rate_limit') assert.equal(e.retryAfterMs, 7000);
          return true;
        });
      }
      await assert.rejects(collect(make().stream(req, { apiKey: 'wrong-key-000000000', baseUrl: fake.url }, new AbortController().signal)), (e: ProviderError) => e.kind === 'auth');
      await assert.rejects(collect(make().stream(req, { baseUrl: fake.url }, new AbortController().signal)), (e: ProviderError) => e.kind === 'auth');
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] abort cancels an in-flight stream`, async () => {
    const fake = await startFakeProvider(kind, () => ({ text: 'a long answer that never finishes', hangAfterChunks: 1 }));
    try {
      const ac = new AbortController();
      const it = make().stream({ model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }, { apiKey: fake.apiKey, baseUrl: fake.url }, ac.signal);
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(collect(it), (e: ProviderError) => e.kind === 'cancelled' || e.kind === 'transient');
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] listModels merges live models with the bundled overlay`, async () => {
    const fake = await startFakeProvider(kind, () => ({ text: '' }));
    try {
      const models = await make().listModels({ apiKey: fake.apiKey, baseUrl: fake.url });
      const known = models.find((m) => m.id === (kind === 'gemini' ? 'gemini-3.8-flash' : 'gpt-5-mini'))!;
      assert.equal(known.origin, 'live+bundled');
      assert.ok(known.pricing && known.pricing.inputPerM > 0);
      const unknown = models.find((m) => m.id === (kind === 'gemini' ? 'gemini-9-test' : 'gpt-5-test'))!;
      assert.equal(unknown.origin, 'live');
      assert.equal(unknown.pricing, null);
      assert.ok(!models.some((m) => /embedding|tts|image/.test(m.id)), models.map((m) => m.id).join(','));
      const offline = await make().listModels({ apiKey: fake.apiKey, baseUrl: 'http://127.0.0.1:1/v1' });
      assert.ok(offline.every((m) => m.origin === 'bundled'));
    } finally {
      await fake.close();
    }
  });
}

test('transcripts are portable across providers (Gemini accepts an OpenAI-produced tool turn)', async () => {
  const openai = await startFakeProvider('openai', ({ index }) => (index === 0 ? { toolCalls: [{ name: 'read_file', args: { path: 'x' } }] } : { text: 'n/a' }));
  const gemini = await startFakeProvider('gemini', () => ({ text: 'continued on gemini' }));
  try {
    const messages: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }];
    const first = done(await collect(new OpenAIAdapter().stream({ model: 'gpt-5-mini', messages, tools }, { apiKey: openai.apiKey, baseUrl: openai.url }, new AbortController().signal)));
    messages.push(first.message);
    const call = first.message.parts.find((p) => p.type === 'tool_call') as { id: string };
    messages.push({ role: 'tool', parts: [{ type: 'tool_result', callId: call.id, name: 'read_file', content: 'data', provenance: { source: 'repo', trust: 'untrusted', taint: true } }] });
    const second = done(await collect(new GeminiAdapter().stream({ model: 'gemini-3.8-flash', messages, tools }, { apiKey: gemini.apiKey, baseUrl: gemini.url }, new AbortController().signal)));
    assert.equal(second.finishReason, 'stop');
    const sent = gemini.requests.at(-1)!.body.contents;
    assert.ok(!JSON.stringify(sent).includes('enc_0'), 'OpenAI encrypted reasoning must not be sent to Gemini');
    assert.equal(sent[1].parts.find((p: { functionCall?: unknown }) => p.functionCall).thoughtSignature, 'skip_thought_signature_validator');
  } finally {
    await openai.close();
    await gemini.close();
  }
});

test('validateJson, parseStructured, and parseRetryAfter follow the schema subset and RFC 9110', () => {
  assert.deepEqual(validateJson({ verdict: 'pass', confidence: 0.5, files: ['a'] }, verdictSchema), []);
  assert.deepEqual(validateJson({ verdict: 'maybe', confidence: 2, files: [1], extra: true }, verdictSchema).sort(), [
    '$.confidence: 2 > maximum 1', '$.extra: additional property not allowed', '$.files[0]: expected string, got number', '$.verdict: "maybe" not in enum ["pass","fail"]',
  ]);
  assert.deepEqual(validateJson({}, verdictSchema).length, 3);
  assert.equal(parseStructured('```json\n{"verdict":"fail","confidence":1,"files":[]}\n```', verdictSchema).valid, true);
  assert.match(parseStructured('not json', verdictSchema).errors[0], /invalid JSON/);
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 0, 1)), 30_000);
  assert.equal(parseRetryAfter('soon'), undefined);
});

for (const { kind, make, model } of adapters) {
  test(`[${kind}] structured output returns schema-valid JSON`, async () => {
    const answer = { verdict: 'fail', confidence: 0.8, files: ['src/a.ts'] };
    const fake = await startFakeProvider(kind, ({ index }) => (index === 0 ? { json: answer } : { text: '{"verdict":"unsure"}' }));
    try {
      const auth = { apiKey: fake.apiKey, baseUrl: fake.url };
      const req: ModelRequest = { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'judge' }] }], responseFormat: { type: 'json_schema', name: 'verdict', schema: verdictSchema, strict: true } };
      const events = await collect(make().stream(req, auth, new AbortController().signal));
      const d = done(events);
      assert.deepEqual(d.structured, { value: answer, valid: true, errors: [] });
      const wire = fake.requests.at(-1)!.body;
      if (kind === 'gemini') {
        assert.equal(wire.generationConfig.responseMimeType, 'application/json');
        assert.equal(wire.generationConfig.responseSchema.type, 'OBJECT');
        assert.deepEqual(wire.generationConfig.responseSchema.properties.verdict, { type: 'STRING', enum: ['pass', 'fail'], format: 'enum' });
        // Gemini has no strict decode mode: explicit degradation, still validated client-side.
        assert.deepEqual(notices(events).map((n) => n.feature), ['strict_schema']);
      } else {
        assert.deepEqual(wire.text.format, { type: 'json_schema', name: 'verdict', schema: verdictSchema, strict: true });
        assert.deepEqual(notices(events), []);
      }
      // A schema-invalid answer is reported, never passed off as valid.
      const bad = done(await collect(make().stream(req, auth, new AbortController().signal)));
      assert.equal(bad.structured?.valid, false);
      assert.ok(bad.structured!.errors.includes('$.verdict: "unsure" not in enum ["pass","fail"]'), JSON.stringify(bad.structured));
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] structured output degrades explicitly when unsupported or not strict-compatible`, async () => {
    const answer = { verdict: 'pass', confidence: 1, files: [] };
    const fake = await startFakeProvider(kind, () => ({ json: answer }));
    try {
      const auth = { apiKey: fake.apiKey, baseUrl: fake.url };
      const loose: JsonSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
      const strictLoose = done(await collect(make().stream({ model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], responseFormat: { type: 'json_schema', name: 'v', schema: loose, strict: true } }, auth, new AbortController().signal)));
      assert.equal(strictLoose.structured?.valid, true);
      if (kind === 'openai') assert.equal(fake.requests.at(-1)!.body.text.format.strict, false, 'non-strict-compatible schema must not be sent strict');

      const noNative = make((m) => ({ ...m, structuredOutput: { supported: false, strict: false } }));
      const events = await collect(noNative.stream({ model, system: 'judge', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], responseFormat: { type: 'json_schema', name: 'verdict', schema: verdictSchema } }, auth, new AbortController().signal));
      assert.deepEqual(notices(events).map((n) => [n.code, n.feature]), [['capability.degraded', 'structured_output']]);
      const wire = fake.requests.at(-1)!.body;
      if (kind === 'gemini') {
        assert.equal(wire.generationConfig?.responseSchema, undefined);
        assert.match(wire.systemInstruction.parts[0].text, /^judge\n\nRespond with only a JSON value/);
      } else {
        assert.equal(wire.text, undefined);
        assert.match(wire.instructions, /^judge\n\nRespond with only a JSON value/);
      }
      assert.deepEqual(done(events).structured, { value: answer, valid: true, errors: [] });
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] 429 with Retry-After is retried after the advertised delay, then succeeds`, async () => {
    const body = kind === 'gemini'
      ? { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }
      : { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } };
    const fake = await startFakeProvider(kind, ({ index }) => (index === 0 ? { error: { status: 429, body, headers: { 'retry-after': '1' } } } : { text: 'ok after retry' }));
    try {
      const retries: Array<{ kind: string; delay: number }> = [];
      const t0 = performance.now();
      const events = await collect(streamWithRetry(make(), { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }, { apiKey: fake.apiKey, baseUrl: fake.url }, new AbortController().signal, {
        onRetry: (e, _attempt, delay) => retries.push({ kind: e.kind, delay }),
      }));
      const elapsed = performance.now() - t0;
      assert.deepEqual(retries, [{ kind: 'rate_limit', delay: 1000 }]);
      assert.ok(elapsed >= 950, `waited ${elapsed} ms, expected >= Retry-After`);
      assert.equal(fake.requests.filter((r) => r.method === 'POST').length, 2);
      assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join(''), 'ok after retry');
      assert.equal(done(events).finishReason, 'stop');
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] retry gives up after maxRetries and never retries non-retryable errors`, async () => {
    const rate = kind === 'gemini' ? { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } } : { error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } };
    const fake = await startFakeProvider(kind, () => ({ error: { status: 429, body: rate, headers: { 'retry-after': '0' } } }));
    try {
      const req: ModelRequest = { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] };
      await assert.rejects(collect(streamWithRetry(make(), req, { apiKey: fake.apiKey, baseUrl: fake.url }, new AbortController().signal, { maxRetries: 2 })), (e: ProviderError) => e.kind === 'rate_limit');
      assert.equal(fake.requests.length, 3);
      await assert.rejects(collect(streamWithRetry(make(), req, { apiKey: 'wrong-key-000000000', baseUrl: fake.url }, new AbortController().signal)), (e: ProviderError) => e.kind === 'auth');
      assert.equal(fake.requests.length, 4, 'auth errors are not retried');
    } finally {
      await fake.close();
    }
  });

  test(`[${kind}] unsupported parallel tool calls degrade to serial with a capability.degraded note`, async () => {
    const script: FakeScript = ({ index, request }) => {
      if (index === 0) return { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] };
      if (index === 1) return { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] };
      return { text: `last: ${lastToolResult(request)}` };
    };
    const fake = await startFakeProvider(kind, script);
    try {
      const adapter = make((m) => ({ ...m, tools: { ...m.tools, parallel: false } }));
      const auth = { apiKey: fake.apiKey, baseUrl: fake.url };
      const messages: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'read both' }] }];
      const executed: string[] = [];
      for (let turn = 0; turn < 3; turn++) {
        const events = await collect(adapter.stream({ model, messages, tools }, auth, new AbortController().signal));
        const d = done(events);
        const calls = d.message.parts.filter((p): p is Extract<typeof p, { type: 'tool_call' }> => p.type === 'tool_call');
        assert.ok(calls.length <= 1, `turn ${turn}: ${calls.length} calls in one turn`);
        assert.equal(events.filter((e) => e.type === 'tool_call').length, calls.length);
        if (turn === 0) {
          assert.equal(notices(events)[0]?.feature, 'parallel_tool_calls');
          assert.equal(notices(events)[0]?.code, 'capability.degraded');
          if (kind === 'openai') assert.equal(fake.requests.at(-1)!.body.parallel_tool_calls, false);
        }
        messages.push(d.message);
        if (!calls.length) {
          assert.equal((d.message.parts.find((p) => p.type === 'text') as { text: string }).text, 'last: contents of b.txt');
          break;
        }
        const path = (calls[0].args as { path: string }).path;
        executed.push(path);
        messages.push({ role: 'tool', parts: [{ type: 'tool_result', callId: calls[0].id, name: 'read_file', content: `contents of ${path}`, provenance: { source: 'repo', trust: 'untrusted', taint: true } }] });
      }
      assert.deepEqual(executed, ['a.txt', 'b.txt']);
    } finally {
      await fake.close();
    }
  });
}

const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API;
const liveEnabled = process.env.HELIX_LIVE === '1';
const live = [
  { kind: 'gemini', key: geminiKey, make: () => new GeminiAdapter() },
  { kind: 'openai', key: process.env.OPENAI_API_KEY, make: () => new OpenAIAdapter() },
] as const;

for (const l of live) {
  const skip = !liveEnabled ? 'set HELIX_LIVE=1 to run live provider checks' : l.key ? false : `no ${l.kind.toUpperCase()} API key in environment`;
  test(`[${l.kind}] LIVE model listing returns >= 1 live model`, { skip }, async () => {
    const models = await l.make().listModels({ apiKey: l.key });
    const liveModels = models.filter((m) => m.origin !== 'bundled');
    console.log(`[${l.kind}] live models: ${liveModels.length} (e.g. ${liveModels.slice(0, 3).map((m) => m.id).join(', ')})`);
    assert.ok(liveModels.length >= 1, 'expected at least one model confirmed by the provider models endpoint');
  });

  test(`[${l.kind}] LIVE structured output returns schema-valid JSON`, { skip }, async () => {
    const adapter = l.make();
    const model = (l.kind === 'gemini' ? process.env.HELIX_LIVE_GEMINI_MODEL : process.env.HELIX_LIVE_OPENAI_MODEL) ?? adapter.defaultModel;
    const req: ModelRequest = {
      model,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'The test suite failed in src/a.ts and src/b.ts. Report verdict "fail" with your confidence and the files.' }] }],
      responseFormat: { type: 'json_schema', name: 'verdict', schema: verdictSchema, strict: true },
      maxOutputTokens: 1024,
    };
    const d = done(await collect(streamWithRetry(adapter, req, { apiKey: l.key }, AbortSignal.timeout(120_000), { maxRetries: 4, baseDelayMs: 2000, onRetry: (e, n, ms) => console.log(`retry ${n + 1} after ${e.kind} in ${ms} ms`) })));
    console.log(`[${l.kind}] ${model} structured: ${JSON.stringify(d.structured)}`);
    assert.equal(d.structured?.valid, true, JSON.stringify(d.structured));
    assert.equal((d.structured!.value as { verdict: string }).verdict, 'fail');
  });

  test(`[${l.kind}] LIVE provider call with tool use`, { skip }, async () => {
    const adapter = l.make();
    const auth = { apiKey: l.key };
    const req: ModelRequest = {
      model: adapter.defaultModel,
      system: 'You are a test harness. Always call the read_file tool exactly once with path "README.md" before answering.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is in README.md?' }] }],
      tools,
      maxOutputTokens: 2048,
    };
    const first = done(await collect(adapter.stream(req, auth, AbortSignal.timeout(120_000))));
    assert.equal(first.usage.source, 'provider');
    assert.ok(first.usage.inputTokens > 0);
    const call = first.message.parts.find((p) => p.type === 'tool_call');
    assert.ok(call, 'model should call read_file');
  });
}
