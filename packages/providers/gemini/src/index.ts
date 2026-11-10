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
  type JsonSchema,
  type Message,
  type ModelManifest,
  type ModelRequest,
  type Part,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from '@helix/protocol';
import { GEMINI_DEFAULT_MODEL, GEMINI_MODELS } from './manifest.ts';

export { GEMINI_MODELS, GEMINI_DEFAULT_MODEL };

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDER = 'gemini';
const SYNTHETIC_ID_PREFIX = 'gcall_';
/** generateContent-capable models that are not text chat/agent models (speech, image, music, transcription). */
const NON_CHAT_MODEL = /(^|-)(tts|image|transcribe|embedding|robotics|computer-use|nano-banana|lyria|aqa)(-|$)|^lyria|^nano-banana/;
/**
 * Documented escape hatch for function calls that carry no Gemini thought signature
 * (for example, transcript turns produced by another provider after a fallback).
 */
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiUsage {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

type GeminiSchema = Record<string, unknown>;

export function toGeminiSchema(schema: JsonSchema): GeminiSchema {
  const out: GeminiSchema = {};
  if (schema.type) out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) {
    out.enum = schema.enum.map(String);
    if (schema.type === 'string') out.format = 'enum';
  }
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (schema.required?.length) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  return out;
}

function signatureOf(part: { opaque?: { provider: string; data: unknown } }): string | undefined {
  if (part.opaque?.provider !== PROVIDER) return undefined;
  const sig = (part.opaque.data as { thoughtSignature?: unknown } | null)?.thoughtSignature;
  return typeof sig === 'string' ? sig : undefined;
}

export function toGeminiRequest(req: ModelRequest): Record<string, unknown> {
  const system: string[] = req.system ? [req.system] : [];
  const contents: GeminiContent[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      for (const p of m.parts) if (p.type === 'text') system.push(p.text);
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.length > 0) {
        const sig = m.role === 'assistant' ? signatureOf(p) : undefined;
        parts.push(sig ? { text: p.text, thoughtSignature: sig } : { text: p.text });
      } else if (p.type === 'tool_call' && m.role === 'assistant') {
        const call: GeminiPart['functionCall'] = { name: p.name, args: (p.args ?? {}) as Record<string, unknown> };
        if (!p.id.startsWith(SYNTHETIC_ID_PREFIX)) call.id = p.id;
        parts.push({ functionCall: call, thoughtSignature: signatureOf(p) ?? FOREIGN_SIGNATURE });
      } else if (p.type === 'tool_result') {
        const response: GeminiPart['functionResponse'] = { name: p.name, response: p.isError ? { error: p.content } : { result: p.content } };
        if (!p.callId.startsWith(SYNTHETIC_ID_PREFIX)) response.id = p.callId;
        parts.push({ functionResponse: response });
      }
    }
    if (parts.length === 0) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  const body: Record<string, unknown> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputSchema) })) }];
    const mode = req.toolChoice === 'none' ? 'NONE' : req.toolChoice === 'required' ? 'ANY' : 'AUTO';
    body.toolConfig = { functionCallingConfig: { mode } };
  }
  const generationConfig: Record<string, unknown> = {};
  if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.reasoningEffort) generationConfig.thinkingConfig = { thinkingLevel: req.reasoningEffort === 'low' ? 'low' : 'high' };
  if (req.responseFormat) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(req.responseFormat.schema);
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

export function normalizeGeminiUsage(u: GeminiUsage | undefined): Usage {
  if (!u) return emptyUsage('estimate');
  const thoughts = u.thoughtsTokenCount ?? 0;
  return {
    inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
    cachedInputTokens: u.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
    reasoningTokens: thoughts,
    source: 'provider',
    raw: u,
  };
}

function mapFinish(reason: string | undefined, hadToolCalls: boolean): FinishReason {
  if (hadToolCalls) return 'tool_calls';
  switch (reason) {
    case undefined:
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'safety';
    default:
      return 'other';
  }
}

function parseRetryDelay(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const delay = (d as { retryDelay?: unknown }).retryDelay;
    if (typeof delay === 'string') {
      const seconds = Number.parseFloat(delay);
      if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
    }
  }
  return undefined;
}

export function geminiHttpError(status: number, bodyText: string, retryAfterHeader?: string | null): ProviderError {
  let message = bodyText.slice(0, 500);
  let rpcStatus = '';
  let retryAfterMs: number | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; status?: string; details?: unknown } };
    if (parsed.error?.message) message = parsed.error.message;
    rpcStatus = parsed.error?.status ?? '';
    retryAfterMs = parseRetryDelay(parsed.error?.details);
  } catch {
    // Non-JSON error body; keep the raw text.
  }
  retryAfterMs ??= parseRetryAfter(retryAfterHeader);
  const text = `gemini ${status}${rpcStatus ? ` ${rpcStatus}` : ''}: ${message}`;
  if (status === 429 || rpcStatus === 'RESOURCE_EXHAUSTED') {
    // A daily/plan quota (e.g. free tier "requests per day", retry in hours) is not worth retrying in-task.
    // Per-minute limits stay retryable (rate_limit).
    const quota = /per day|PerDay/i.test(bodyText) || (retryAfterMs !== undefined && retryAfterMs > 10 * 60_000);
    return new ProviderError(PROVIDER, quota ? 'plan_limit' : 'rate_limit', text, { status, retryAfterMs });
  }
  // Gemini reports a bad key as 400 INVALID_ARGUMENT with reason API_KEY_INVALID.
  const keyInvalid = /API_KEY_INVALID|API key not valid|API key expired/i.test(bodyText);
  if (keyInvalid || status === 401 || status === 403 || rpcStatus === 'UNAUTHENTICATED' || rpcStatus === 'PERMISSION_DENIED') return new ProviderError(PROVIDER, 'auth', text, { status });
  if (status === 400 && /token|context|too long|exceeds/i.test(message) && /limit|exceed|maximum|too long/i.test(message)) {
    return new ProviderError(PROVIDER, 'context_overflow', text, { status });
  }
  if (status === 400 || status === 404 || status === 422) return new ProviderError(PROVIDER, 'invalid_request', text, { status });
  if (status >= 500) return new ProviderError(PROVIDER, 'transient', text, { status, retryAfterMs });
  return new ProviderError(PROVIDER, 'fatal', text, { status });
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly defaultModel = GEMINI_DEFAULT_MODEL;
  private readonly fetchImpl: typeof fetch;
  private readonly models: ModelManifest[];
  private readonly live = new Map<string, ModelManifest>();

  /** `models` replaces the bundled overlay (used to describe deployments with narrower capabilities). */
  constructor(opts: { fetch?: typeof fetch; models?: ModelManifest[] } = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.models = opts.models ?? GEMINI_MODELS;
  }

  bundledModels(): ModelManifest[] {
    return this.models.map((m) => ({ ...m }));
  }

  /** Capability manifest for a model: last live listing, else the bundled overlay. */
  manifestFor(model: string): ModelManifest | undefined {
    return this.live.get(model) ?? this.models.find((m) => m.id === model);
  }

  private base(auth: AuthContext): string {
    return (auth.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private headers(auth: AuthContext): Record<string, string> {
    if (!auth.apiKey) throw new ProviderError(PROVIDER, 'auth', 'no Gemini API key configured (set GEMINI_API_KEY)');
    return { 'content-type': 'application/json', 'x-goog-api-key': auth.apiKey };
  }

  async listModels(auth: AuthContext): Promise<ModelManifest[]> {
    try {
      const res = await this.fetchImpl(`${this.base(auth)}/models?pageSize=1000`, { headers: this.headers(auth) });
      if (!res.ok) throw geminiHttpError(res.status, await res.text());
      const body = (await res.json()) as { models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }> };
      const overlay = new Map(this.models.map((m) => [m.id, m]));
      const out: ModelManifest[] = [];
      for (const live of body.models ?? []) {
        if (!live.supportedGenerationMethods?.includes('generateContent')) continue;
        const id = live.name.replace(/^models\//, '');
        if (NON_CHAT_MODEL.test(id)) continue;
        const known = overlay.get(id);
        if (known) {
          out.push({ ...known, contextWindow: live.inputTokenLimit ?? known.contextWindow, maxOutput: live.outputTokenLimit ?? known.maxOutput, origin: 'live+bundled' });
        } else {
          out.push({
            ...this.models[0], id, displayName: live.displayName ?? id, status: /preview/.test(id) ? 'preview' : /exp/.test(id) ? 'experimental' : 'stable',
            contextWindow: live.inputTokenLimit ?? 32_768, maxOutput: live.outputTokenLimit ?? 8_192, pricing: null, origin: 'live',
          });
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

  async countTokens(req: ModelRequest, auth?: AuthContext): Promise<TokenCount> {
    if (!auth?.apiKey) return { inputTokens: estimateTokens(req), exact: false };
    try {
      const body = toGeminiRequest(req);
      const res = await this.fetchImpl(`${this.base(auth)}/models/${encodeURIComponent(req.model)}:countTokens`, {
        method: 'POST', headers: this.headers(auth), body: JSON.stringify({ generateContentRequest: { model: `models/${req.model}`, ...body } }),
      });
      if (!res.ok) throw geminiHttpError(res.status, await res.text());
      const parsed = (await res.json()) as { totalTokens?: number };
      if (typeof parsed.totalTokens === 'number') return { inputTokens: parsed.totalTokens, exact: true };
    } catch {
      // Counting is advisory; fall back to the estimator.
    }
    return { inputTokens: estimateTokens(req), exact: false };
  }

  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const e = error as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === 'AbortError') return new ProviderError(PROVIDER, 'cancelled', 'request aborted');
    if ((e?.name === 'TypeError' && /fetch failed|network|socket/i.test(e.message ?? '')) || e?.cause?.code) return new ProviderError(PROVIDER, 'transient', `network error: ${e.message ?? String(error)}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
    return new ProviderError(PROVIDER, 'fatal', e?.message ?? String(error));
  }

  async *stream(original: ModelRequest, auth: AuthContext, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const plan = planCapabilities(original, this.manifestFor(original.model));
    const req = plan.request;
    yield* degradationEvents(plan.degradations);
    const serial = req.parallelToolCalls === false;
    let droppedCalls = 0;
    const url = `${this.base(auth)}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers: this.headers(auth), body: JSON.stringify(toGeminiRequest(req)), signal });
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!res.ok || !res.body) throw geminiHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));

    const parts: Part[] = [];
    let currentText: Extract<Part, { type: 'text' }> | null = null;
    let reasoning = '';
    let usage: Usage | undefined;
    let finish: string | undefined;
    let responseId: string | undefined;
    let callIndex = 0;
    let toolCalls = 0;
    try {
      for await (const m of readSse(res.body, signal)) {
        if (!m.data || m.data === '[DONE]') continue;
        let chunk: { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>; usageMetadata?: GeminiUsage; responseId?: string; promptFeedback?: { blockReason?: string }; error?: { code?: number } };
        try {
          chunk = JSON.parse(m.data);
        } catch {
          continue;
        }
        if (chunk.error) throw geminiHttpError(chunk.error.code ?? 500, m.data);
        if (chunk.promptFeedback?.blockReason) throw new ProviderError(PROVIDER, 'safety', `prompt blocked: ${chunk.promptFeedback.blockReason}`);
        responseId ??= chunk.responseId;
        if (chunk.usageMetadata) usage = normalizeGeminiUsage(chunk.usageMetadata);
        const candidate = chunk.candidates?.[0];
        for (const p of candidate?.content?.parts ?? []) {
          if (p.functionCall) {
            // Gemini has no request flag for this; enforce one call per turn client-side.
            if (serial && toolCalls >= 1) {
              droppedCalls++;
              continue;
            }
            currentText = null;
            const id = p.functionCall.id ?? `${SYNTHETIC_ID_PREFIX}${callIndex}`;
            callIndex++;
            toolCalls++;
            const args = p.functionCall.args ?? {};
            parts.push({ type: 'tool_call', id, name: p.functionCall.name, args, opaque: p.thoughtSignature ? { provider: PROVIDER, data: { thoughtSignature: p.thoughtSignature } } : undefined });
            yield { type: 'tool_call', id, name: p.functionCall.name, args };
          } else if (typeof p.text === 'string' && p.thought) {
            reasoning += p.text;
            yield { type: 'reasoning_delta', text: p.text };
          } else if (typeof p.text === 'string' || p.thoughtSignature) {
            const text = p.text ?? '';
            if (!currentText) {
              currentText = { type: 'text', text: '' };
              parts.push(currentText);
            }
            currentText.text += text;
            if (p.thoughtSignature) currentText.opaque = { provider: PROVIDER, data: { thoughtSignature: p.thoughtSignature } };
            if (text) yield { type: 'text_delta', text };
          }
        }
        if (candidate?.finishReason) finish = candidate.finishReason;
      }
    } catch (error) {
      throw this.normalizeError(error);
    }
    const finalParts: Part[] = [];
    if (reasoning) finalParts.push({ type: 'reasoning', summary: reasoning });
    for (const p of parts) if (!(p.type === 'text' && p.text === '' && !p.opaque)) finalParts.push(p);
    const message: Message = { role: 'assistant', parts: finalParts };
    if (droppedCalls > 0) yield* degradationEvents([{ feature: 'parallel_tool_calls', detail: `serialized: kept 1 of ${droppedCalls + 1} tool calls this turn` }]);
    const structured = plan.validateSchema && toolCalls === 0
      ? parseStructured(finalParts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''), plan.validateSchema)
      : undefined;
    yield { type: 'done', message, usage: usage ?? { ...emptyUsage('estimate'), inputTokens: estimateTokens(req) }, finishReason: mapFinish(finish, toolCalls > 0), responseId, structured };
  }
}
