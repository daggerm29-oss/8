import {
  ProviderError,
  degradationEvents,
  estimateTokens,
  parseRetryAfter,
  parseStructured,
  planCapabilities,
  emptyUsage,
  readSse,
  type AuthContext,
  type FinishReason,
  type Message,
  type ModelManifest,
  type ModelRequest,
  type Part,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from '@helix/protocol';
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS, isReasoningModelId } from './manifest.ts';

export { OPENAI_MODELS, OPENAI_DEFAULT_MODEL };

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const PROVIDER = 'openai';

interface OpenAIUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

type OutputItem =
  | { type: 'message'; role: 'assistant'; content?: Array<{ type: string; text?: string; refusal?: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'reasoning'; id: string; encrypted_content?: string | null; summary?: Array<{ type: string; text: string }> }
  | { type: string; [k: string]: unknown };

interface ResponseObject {
  id?: string;
  status?: string;
  output?: OutputItem[];
  usage?: OpenAIUsage;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
}

function isReasoning(model: string): boolean {
  const known = OPENAI_MODELS.find((m) => m.id === model);
  return known ? Boolean(known.reasoning) : isReasoningModelId(model);
}

export function toOpenAIRequest(req: ModelRequest): Record<string, unknown> {
  const instructions: string[] = req.system ? [req.system] : [];
  const input: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      for (const p of m.parts) if (p.type === 'text') instructions.push(p.text);
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.length > 0) {
        input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: p.text });
      } else if (p.type === 'reasoning' && m.role === 'assistant' && p.opaque?.provider === PROVIDER) {
        const data = p.opaque.data as { id?: string; encrypted_content?: string };
        if (data?.id && data.encrypted_content) input.push({ type: 'reasoning', id: data.id, encrypted_content: data.encrypted_content, summary: [] });
      } else if (p.type === 'tool_call' && m.role === 'assistant') {
        input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args ?? {}) });
      } else if (p.type === 'tool_result') {
        input.push({ type: 'function_call_output', call_id: p.callId, output: p.isError ? `ERROR: ${p.content}` : p.content });
      }
    }
  }
  const reasoning = isReasoning(req.model);
  const body: Record<string, unknown> = { model: req.model, input, stream: true, store: false };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    body.tool_choice = req.toolChoice ?? 'auto';
    body.parallel_tool_calls = req.parallelToolCalls ?? true;
  }
  if (req.responseFormat) {
    const f = req.responseFormat;
    body.text = { format: { type: 'json_schema', name: f.name, schema: f.schema, strict: f.strict ?? false } };
  }
  if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
  if (reasoning) {
    body.include = ['reasoning.encrypted_content'];
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
  } else if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  return body;
}

export function normalizeOpenAIUsage(u: OpenAIUsage | undefined): Usage {
  if (!u) return emptyUsage('estimate');
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    source: 'provider',
    raw: u,
  };
}

export function openaiHttpError(status: number, bodyText: string, retryAfterHeader?: string | null): ProviderError {
  let message = bodyText.slice(0, 500);
  let code = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; code?: string | null; type?: string } };
    if (parsed.error?.message) message = parsed.error.message;
    code = parsed.error?.code ?? parsed.error?.type ?? '';
  } catch {
    // Non-JSON error body; keep the raw text.
  }
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const text = `openai ${status}${code ? ` ${code}` : ''}: ${message}`;
  if (code === 'insufficient_quota') return new ProviderError(PROVIDER, 'plan_limit', text, { status });
  if (status === 429) return new ProviderError(PROVIDER, 'rate_limit', text, { status, retryAfterMs });
  if (status === 401 || status === 403) return new ProviderError(PROVIDER, 'auth', text, { status });
  if (code === 'context_length_exceeded' || /context (length|window)|maximum context/i.test(message)) return new ProviderError(PROVIDER, 'context_overflow', text, { status });
  if (status === 400 || status === 404 || status === 422) return new ProviderError(PROVIDER, 'invalid_request', text, { status });
  if (status >= 500) return new ProviderError(PROVIDER, 'transient', text, { status, retryAfterMs });
  return new ProviderError(PROVIDER, 'fatal', text, { status });
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json__: raw };
  }
}

export function outputToMessage(output: OutputItem[]): { message: Message; toolCalls: number } {
  const parts: Part[] = [];
  let toolCalls = 0;
  for (const item of output) {
    if (item.type === 'message') {
      const text = ((item as Extract<OutputItem, { type: 'message' }>).content ?? [])
        .map((c) => (c.type === 'output_text' ? (c.text ?? '') : c.type === 'refusal' ? `[refusal] ${c.refusal ?? ''}` : ''))
        .join('');
      if (text) parts.push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      const fc = item as Extract<OutputItem, { type: 'function_call' }>;
      toolCalls++;
      parts.push({ type: 'tool_call', id: fc.call_id, name: fc.name, args: parseArgs(fc.arguments) });
    } else if (item.type === 'reasoning') {
      const r = item as Extract<OutputItem, { type: 'reasoning' }>;
      const summary = (r.summary ?? []).map((s) => s.text).join('\n');
      parts.push({ type: 'reasoning', summary: summary || undefined, opaque: r.encrypted_content ? { provider: PROVIDER, data: { id: r.id, encrypted_content: r.encrypted_content } } : undefined });
    }
  }
  return { message: { role: 'assistant', parts }, toolCalls };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly defaultModel = OPENAI_DEFAULT_MODEL;
  private readonly fetchImpl: typeof fetch;
  private readonly models: ModelManifest[];
  private readonly live = new Map<string, ModelManifest>();

  /** `models` replaces the bundled overlay (used to describe deployments with narrower capabilities). */
  constructor(opts: { fetch?: typeof fetch; models?: ModelManifest[] } = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.models = opts.models ?? OPENAI_MODELS;
  }

  bundledModels(): ModelManifest[] {
    return this.models.map((m) => ({ ...m }));
  }

  /** Capability manifest for a model: last live listing, else the bundled overlay. */
  manifestFor(model: string): ModelManifest | undefined {
    return this.live.get(model) ?? this.models.find((m) => m.id === model);
  }

  private base(auth: AuthContext): string {
    return (auth.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private headers(auth: AuthContext): Record<string, string> {
    const token = auth.apiKey ?? auth.accessToken;
    if (!token) throw new ProviderError(PROVIDER, 'auth', 'no OpenAI API key configured (set OPENAI_API_KEY)');
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  }

  async listModels(auth: AuthContext): Promise<ModelManifest[]> {
    try {
      const res = await this.fetchImpl(`${this.base(auth)}/models`, { headers: this.headers(auth) });
      if (!res.ok) throw openaiHttpError(res.status, await res.text());
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const overlay = new Map(this.models.map((m) => [m.id, m]));
      const out: ModelManifest[] = [];
      for (const { id } of body.data ?? []) {
        if (!/^(gpt-|o\d)/.test(id) || /audio|realtime|transcribe|tts|image|search|embedding/.test(id)) continue;
        const known = overlay.get(id);
        if (known) out.push({ ...known, origin: 'live+bundled' });
        else {
          const reasoning = isReasoningModelId(id);
          out.push({ ...this.models[0], id, displayName: id, reasoning: reasoning ? OPENAI_MODELS[0].reasoning : undefined, temperature: !reasoning, pricing: null, origin: 'live' });
        }
      }
      for (const m of out) this.live.set(m.id, m);
      return out.length ? out : this.bundledModels();
    } catch (error) {
      const e = this.normalizeError(error);
      if (e.kind === 'auth') throw e;
      return this.bundledModels();
    }
  }

  async countTokens(req: ModelRequest): Promise<TokenCount> {
    return { inputTokens: estimateTokens(req), exact: false };
  }

  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const e = error as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === 'AbortError') return new ProviderError(PROVIDER, 'cancelled', 'request aborted');
    if ((e?.name === 'TypeError' && /fetch failed|network|socket/i.test(e.message ?? '')) || e?.cause?.code) {
      return new ProviderError(PROVIDER, 'transient', `network error: ${e.message ?? String(error)}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
    }
    return new ProviderError(PROVIDER, 'fatal', e?.message ?? String(error));
  }

  async *stream(original: ModelRequest, auth: AuthContext, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const plan = planCapabilities(original, this.manifestFor(original.model));
    const req = plan.request;
    yield* degradationEvents(plan.degradations);
    const serial = req.parallelToolCalls === false;
    let streamedCalls = 0;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base(auth)}/responses`, { method: 'POST', headers: this.headers(auth), body: JSON.stringify(toOpenAIRequest(req)), signal });
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!res.ok || !res.body) throw openaiHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));

    let final: ResponseObject | undefined;
    let finish: FinishReason = 'stop';
    try {
      for await (const m of readSse(res.body, signal)) {
        if (!m.data || m.data === '[DONE]') continue;
        let event: { type?: string; delta?: string; item?: OutputItem; response?: ResponseObject; code?: string; message?: string; error?: { code?: string; message?: string } };
        try {
          event = JSON.parse(m.data);
        } catch {
          continue;
        }
        const type = event.type ?? m.event;
        if (type === 'response.output_text.delta' && event.delta) {
          yield { type: 'text_delta', text: event.delta };
        } else if (type === 'response.reasoning_summary_text.delta' && event.delta) {
          yield { type: 'reasoning_delta', text: event.delta };
        } else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
          const fc = event.item as Extract<OutputItem, { type: 'function_call' }>;
          if (serial && streamedCalls >= 1) continue;
          streamedCalls++;
          yield { type: 'tool_call', id: fc.call_id, name: fc.name, args: parseArgs(fc.arguments) };
        } else if (type === 'response.completed') {
          final = event.response;
        } else if (type === 'response.incomplete') {
          final = event.response;
          const reason = event.response?.incomplete_details?.reason;
          finish = reason === 'content_filter' ? 'safety' : 'length';
        } else if (type === 'response.failed') {
          const err = event.response?.error;
          throw openaiHttpError(err?.code === 'rate_limit_exceeded' ? 429 : 500, JSON.stringify({ error: err ?? { message: 'response failed' } }));
        } else if (type === 'error') {
          const err = event.error ?? { code: event.code, message: event.message };
          const status = err.code === 'rate_limit_exceeded' ? 429 : err.code === 'context_length_exceeded' ? 400 : 500;
          throw openaiHttpError(status, JSON.stringify({ error: err }));
        }
      }
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!final) throw new ProviderError(PROVIDER, 'transient', 'stream ended without response.completed');
    let { message, toolCalls } = outputToMessage(final.output ?? []);
    if (serial && toolCalls > 1) {
      // parallel_tool_calls=false should prevent this; enforce it if the server ignores the flag.
      let kept = 0;
      message = { ...message, parts: message.parts.filter((p) => p.type !== 'tool_call' || kept++ === 0) };
      yield* degradationEvents([{ feature: 'parallel_tool_calls', detail: `serialized: kept 1 of ${toolCalls} tool calls this turn` }]);
      toolCalls = 1;
    }
    if (toolCalls > 0 && finish === 'stop') finish = 'tool_calls';
    const structured = plan.validateSchema && toolCalls === 0
      ? parseStructured(message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''), plan.validateSchema)
      : undefined;
    const usage = final.usage ? normalizeOpenAIUsage(final.usage) : { ...emptyUsage('estimate'), inputTokens: estimateTokens(req) };
    yield { type: 'done', message, usage, finishReason: finish, responseId: final.id, structured };
  }
}
