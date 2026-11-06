import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, SseParser, type Message, type ModelRequest, type ProviderAdapter, type StreamEvent } from '@helix/protocol';
import { GeminiAdapter } from '@helix/provider-gemini';
import { OpenAIAdapter } from '@helix/provider-openai';
import { startFakeProvider, lastToolResult, type FakeScript } from '../src/index.ts';

const adapters: Array<{ kind: 'gemini' | 'openai'; make: () => ProviderAdapter; model: string }> = [
  { kind: 'gemini', make: () => new GeminiAdapter(), model: 'gemini-3.8-flash' },
  { kind: 'openai', make: () => new OpenAIAdapter(), model: 'gpt-5-mini' },
];

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
      assert.ok(!models.some((m) => /embedding|tts/.test(m.id)));
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

const live = [
  { kind: 'gemini', key: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY, make: () => new GeminiAdapter() },
  { kind: 'openai', key: process.env.OPENAI_API_KEY, make: () => new OpenAIAdapter() },
] as const;

for (const l of live) {
  test(`[${l.kind}] LIVE provider call with tool use`, { skip: l.key ? false : `no ${l.kind.toUpperCase()} API key in environment` }, async () => {
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
