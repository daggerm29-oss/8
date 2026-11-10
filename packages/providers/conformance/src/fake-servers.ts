import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY protocol-faithful fake provider servers.
 *
 * They speak the real Gemini `streamGenerateContent` SSE and OpenAI Responses API SSE wire formats
 * and enforce the request invariants the real APIs enforce (auth headers, function-call/response
 * pairing, Gemini thought-signature echo). Model *behavior* comes from a caller-supplied script,
 * so these verify Helix plumbing, never model intelligence.
 */

export interface FakeToolCall {
  name: string;
  args: unknown;
}

export interface FakeTurn {
  text?: string;
  /** Structured output: emitted as the JSON text of the answer. */
  json?: unknown;
  toolCalls?: FakeToolCall[];
  reasoningSummary?: string;
  usage?: { input: number; cached?: number; output: number; reasoning?: number };
  error?: { status: number; body: unknown; headers?: Record<string, string> };
  delayMs?: number;
  /** Emit this many SSE chunks and then hang until the client aborts. */
  hangAfterChunks?: number;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export type FakeScript = (ctx: { request: CapturedRequest; index: number }) => FakeTurn | Promise<FakeTurn>;

export interface UsageTotals {
  calls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface FakeServer {
  kind: 'gemini' | 'openai';
  url: string;
  apiKey: string;
  requests: CapturedRequest[];
  /** Totals of usage this server *reported* to clients (normalized like Helix: output includes reasoning). */
  reported: UsageTotals;
  close(): Promise<void>;
}

const estimate = (value: unknown) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

function splitText(text: string): string[] {
  if (text.length <= 8) return [text];
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

async function emit(res: ServerResponse, frames: string[], turn: FakeTurn): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    if (turn.hangAfterChunks !== undefined && i >= turn.hangAfterChunks) {
      await new Promise<void>((resolve) => res.on('close', () => resolve()));
      return;
    }
    res.write(frames[i]);
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}

// ---------------------------------------------------------------- Gemini

function geminiError(status: number, message: string, rpcStatus: string) {
  return { error: { code: status, message, status: rpcStatus } };
}

/** Enforces Gemini request invariants; returns an error message or null. */
function validateGemini(body: any, issuedSignatures: Set<string>): string | null {
  if (!Array.isArray(body?.contents) || body.contents.length === 0) return '* GenerateContentRequest.contents: contents is not specified';
  let pendingCalls = 0;
  for (const c of body.contents) {
    if (c.role !== 'user' && c.role !== 'model') return `invalid role: ${c.role}`;
    if (!Array.isArray(c.parts) || c.parts.length === 0) return 'contents.parts must not be empty';
    const calls = c.parts.filter((p: any) => p.functionCall).length;
    const responses = c.parts.filter((p: any) => p.functionResponse).length;
    if (responses > 0 && responses !== pendingCalls) {
      return 'Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn.';
    }
    for (const p of c.parts) {
      if (p.functionCall) {
        const sig = p.thoughtSignature;
        if (!sig) return 'Function call is missing a thought_signature in functionCall parts.';
        if (sig !== 'skip_thought_signature_validator' && !issuedSignatures.has(sig)) return `Corrupted thought signature: ${sig}`;
      }
    }
    pendingCalls = c.role === 'model' ? calls : 0;
  }
  const gc = body.generationConfig ?? {};
  if (gc.responseSchema !== undefined) {
    if (gc.responseMimeType !== 'application/json') return 'responseSchema requires responseMimeType "application/json".';
    if (typeof gc.responseSchema.type !== 'string' || gc.responseSchema.type !== gc.responseSchema.type.toUpperCase()) return `invalid responseSchema type ${gc.responseSchema.type}`;
    if (JSON.stringify(gc.responseSchema).includes('additionalProperties')) return 'Invalid JSON payload received. Unknown name "additionalProperties" at generation_config.response_schema';
  }
  for (const t of body.tools ?? []) {
    for (const fd of t.functionDeclarations ?? []) {
      if (fd.parameters && typeof fd.parameters.type === 'string' && fd.parameters.type !== fd.parameters.type.toUpperCase()) return `invalid schema type ${fd.parameters.type}`;
    }
  }
  return null;
}

function geminiFrames(turn: FakeTurn, body: any, index: number, signatures: Set<string>, reported: UsageTotals): string[] {
  const frames: string[] = [];
  const responseId = `resp_${index}`;
  if (turn.json !== undefined) turn = { ...turn, text: JSON.stringify(turn.json) };
  if (turn.reasoningSummary) frames.push(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: turn.reasoningSummary, thought: true }] } }], responseId })}\r\n\r\n`);
  for (const piece of turn.text ? splitText(turn.text) : []) {
    frames.push(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: piece }] } }], responseId })}\r\n\r\n`);
  }
  const callParts = (turn.toolCalls ?? []).map((c, i) => {
    const sig = `sig_${index}_${i}`;
    signatures.add(sig);
    return { functionCall: { name: c.name, args: c.args }, thoughtSignature: sig };
  });
  const input = turn.usage?.input ?? estimate(body.contents);
  const cached = turn.usage?.cached ?? 0;
  const reasoning = turn.usage?.reasoning ?? 0;
  const candidates = turn.usage ? turn.usage.output - reasoning : estimate([turn.text, turn.toolCalls]);
  reported.calls++;
  reported.input += input;
  reported.cached += cached;
  reported.output += candidates + reasoning;
  reported.reasoning += reasoning;
  const usageMetadata = { promptTokenCount: input, cachedContentTokenCount: cached || undefined, candidatesTokenCount: candidates, thoughtsTokenCount: reasoning || undefined, totalTokenCount: input + candidates + reasoning };
  frames.push(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: callParts.length ? callParts : [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata, responseId, modelVersion: body.__model })}\r\n\r\n`);
  return frames;
}

// ---------------------------------------------------------------- OpenAI

function openaiError(message: string, code: string | null, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code } };
}

/** Mirrors the Responses API strict-schema rules (every object: all properties required, additionalProperties false). */
function strictSchemaError(schema: any, path = 'schema'): string | null {
  if (schema?.type === 'object') {
    if (schema.additionalProperties !== false) return `Invalid schema for response_format: In context=('${path}'), 'additionalProperties' is required to be supplied and to be false.`;
    for (const k of Object.keys(schema.properties ?? {})) {
      if (!schema.required?.includes(k)) return `Invalid schema for response_format: In context=('${path}'), 'required' is required to include every key in properties. Missing '${k}'.`;
      const sub = strictSchemaError(schema.properties[k], `${path}.${k}`);
      if (sub) return sub;
    }
  }
  if (schema?.type === 'array' && schema.items) return strictSchemaError(schema.items, `${path}[]`);
  return null;
}

function validateOpenAI(body: any): string | null {
  if (typeof body?.model !== 'string') return "Missing required parameter: 'model'.";
  if (!Array.isArray(body.input)) return "Invalid type for 'input'.";
  if (body.stream !== true) return 'fake server only supports stream=true';
  const calls = new Set<string>();
  for (const item of body.input) {
    if (item.type === 'function_call') calls.add(item.call_id);
    if (item.type === 'function_call_output' && !calls.has(item.call_id)) return `No tool call found for function call output with call_id ${item.call_id}.`;
    if (item.type === 'reasoning' && (!item.id || !item.encrypted_content)) return 'reasoning items require id and encrypted_content when store=false';
  }
  const format = body.text?.format;
  if (format) {
    if (format.type !== 'json_schema') return `Invalid value for 'text.format.type': ${format.type}`;
    if (typeof format.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)) return "Invalid 'text.format.name'.";
    if (!format.schema || typeof format.schema !== 'object') return "Missing required parameter: 'text.format.schema'.";
    if (format.strict) {
      const err = strictSchemaError(format.schema);
      if (err) return err;
    }
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') return "Invalid type for 'parallel_tool_calls'.";
  return null;
}

function openaiFrames(turn: FakeTurn, body: any, index: number, reported: UsageTotals): string[] {
  const frames: string[] = [];
  const ev = (type: string, data: Record<string, unknown>) => frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `resp_${index}`;
  if (turn.json !== undefined) turn = { ...turn, text: JSON.stringify(turn.json) };
  // Real API behavior: parallel_tool_calls=false yields at most one function call per response.
  if (body.parallel_tool_calls === false && (turn.toolCalls?.length ?? 0) > 1) turn = { ...turn, toolCalls: turn.toolCalls!.slice(0, 1) };
  ev('response.created', { response: { id, status: 'in_progress', output: [] } });
  const output: any[] = [];
  if (body.include?.includes('reasoning.encrypted_content')) {
    output.push({ type: 'reasoning', id: `rs_${index}`, encrypted_content: `enc_${index}`, summary: turn.reasoningSummary ? [{ type: 'summary_text', text: turn.reasoningSummary }] : [] });
  }
  if (turn.text) {
    for (const piece of splitText(turn.text)) ev('response.output_text.delta', { item_id: `msg_${index}`, output_index: output.length, content_index: 0, delta: piece });
    output.push({ type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text, annotations: [] }] });
  }
  (turn.toolCalls ?? []).forEach((c, i) => {
    const item = { type: 'function_call', id: `fc_${index}_${i}`, call_id: `call_${index}_${i}`, name: c.name, arguments: JSON.stringify(c.args), status: 'completed' };
    ev('response.output_item.done', { output_index: output.length, item });
    output.push(item);
  });
  const input = turn.usage?.input ?? estimate(body.input);
  const cached = turn.usage?.cached ?? 0;
  const reasoning = turn.usage?.reasoning ?? 0;
  const out = turn.usage?.output ?? estimate([turn.text, turn.toolCalls]) + reasoning;
  reported.calls++;
  reported.input += input;
  reported.cached += cached;
  reported.output += out;
  reported.reasoning += reasoning;
  const usage = { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: out, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + out };
  ev('response.completed', { response: { id, status: 'completed', model: body.model, output, usage } });
  return frames;
}

// ---------------------------------------------------------------- server

export async function startFakeProvider(kind: 'gemini' | 'openai', script: FakeScript, opts: { apiKey?: string } = {}): Promise<FakeServer> {
  const apiKey = opts.apiKey ?? `fake-${kind}-key-0123456789abcdef`;
  const requests: CapturedRequest[] = [];
  const reported: UsageTotals = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  const signatures = new Set<string>();
  let turnIndex = 0;

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return json(res, 400, kind === 'gemini' ? geminiError(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT') : openaiError('We could not parse the JSON body of your request.', null));
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const captured: CapturedRequest = { method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body };
    requests.push(captured);

    const authorized = kind === 'gemini' ? req.headers['x-goog-api-key'] === apiKey : req.headers.authorization === `Bearer ${apiKey}`;
    if (!authorized) {
      return kind === 'gemini'
        ? json(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
        : json(res, 401, openaiError('Incorrect API key provided.', 'invalid_api_key'));
    }

    if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
      return kind === 'gemini'
        ? json(res, 200, { models: [
          { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/gemini-9-test', displayName: 'Gemini 9 Test', inputTokenLimit: 2_000_000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', supportedGenerationMethods: ['generateContent'] },
        ] })
        : json(res, 200, { object: 'list', data: [{ id: 'gpt-5-mini', object: 'model' }, { id: 'gpt-5-test', object: 'model' }, { id: 'tts-1', object: 'model' }] });
    }

    if (kind === 'gemini' && url.pathname.endsWith(':countTokens')) {
      return json(res, 200, { totalTokens: estimate(body?.generateContentRequest?.contents) });
    }

    const isGenerate = kind === 'gemini' ? url.pathname.endsWith(':streamGenerateContent') : url.pathname.endsWith('/responses');
    if (!isGenerate || req.method !== 'POST') return json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });

    if (kind === 'gemini') {
      if (url.searchParams.get('alt') !== 'sse') return json(res, 400, geminiError(400, 'fake server only supports alt=sse', 'INVALID_ARGUMENT'));
      const invalid = validateGemini(body, signatures);
      if (invalid) return json(res, 400, geminiError(400, invalid, 'INVALID_ARGUMENT'));
      body.__model = decodeURIComponent(url.pathname.split('/models/')[1]?.split(':')[0] ?? '');
    } else {
      const invalid = validateOpenAI(body);
      if (invalid) return json(res, 400, openaiError(invalid, null));
    }

    const index = turnIndex++;
    let turn: FakeTurn;
    try {
      turn = await script({ request: captured, index });
    } catch (error) {
      return json(res, 500, { error: { code: 500, message: `fake script error: ${(error as Error).message}`, status: 'INTERNAL' } });
    }
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.error) return json(res, turn.error.status, turn.error.body, turn.error.headers);
    sse(res);
    const frames = kind === 'gemini' ? geminiFrames(turn, body, index, signatures, reported) : openaiFrames(turn, body, index, reported);
    await emit(res, frames, turn);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = kind === 'gemini' ? `http://127.0.0.1:${port}/v1beta` : `http://127.0.0.1:${port}/v1`;
  return {
    kind, url, apiKey, requests, reported,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Text of the most recent tool result in a captured provider request (either wire format). */
export function lastToolResult(request: CapturedRequest): string | null {
  const body = request.body;
  if (Array.isArray(body?.contents)) {
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const parts = body.contents[i].parts ?? [];
      for (let j = parts.length - 1; j >= 0; j--) {
        const r = parts[j].functionResponse?.response;
        if (r) return String(r.result ?? r.error ?? '');
      }
    }
    return null;
  }
  if (Array.isArray(body?.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) if (body.input[i].type === 'function_call_output') return String(body.input[i].output);
  }
  return null;
}

/** All user-visible text in a captured request (system + user messages), for scripted decisions. */
export function requestText(request: CapturedRequest): string {
  return JSON.stringify(request.body ?? '');
}
