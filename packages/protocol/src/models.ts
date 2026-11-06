/**
 * Provider-neutral message IR and adapter contract (architecture.md §7.1, §7.2).
 * Lives in the leaf `protocol` package so the engine, provider packages, and clients share it (IMPL-ADR-006).
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type TrustTier = 'trusted' | 'verified' | 'untrusted';

export interface Provenance {
  source: 'builtin' | 'mcp' | 'web' | 'repo';
  trust: TrustTier;
  taint: boolean;
}

/** Provider-specific state that may only be replayed to the same provider (§7.1 `reasoning.opaque`). */
export interface ProviderOpaque {
  provider: string;
  data: unknown;
}

export interface CacheHint {
  breakpoint: boolean;
  ttl?: 'short' | 'long';
}

export type Part =
  | { type: 'text'; text: string; cache?: CacheHint; opaque?: ProviderOpaque }
  | { type: 'tool_call'; id: string; name: string; args: unknown; opaque?: ProviderOpaque }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean; provenance: Provenance; dataRef?: string }
  | { type: 'reasoning'; summary?: string; opaque?: ProviderOpaque };

export interface Message {
  role: Role;
  parts: Part[];
  meta?: { agentId?: string; stepId?: string };
}

export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean;
};

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Normalized usage. `inputTokens` includes cached tokens; `outputTokens` includes reasoning tokens
 * (both are billed as output by Gemini and OpenAI). Subsets are reported separately.
 */
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  source: 'provider' | 'estimate';
  raw?: unknown;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'safety' | 'other';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; message: Message; usage: Usage; finishReason: FinishReason; responseId?: string };

export interface AuthContext {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
}

export interface ModelManifest {
  id: string;
  provider: string;
  displayName: string;
  status: 'stable' | 'preview' | 'experimental' | 'deprecated';
  contextWindow: number;
  maxOutput: number;
  modalities: { input: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>; output: Array<'text' | 'image' | 'audio'> };
  tools: { supported: boolean; parallel: boolean; strictSchema: boolean; dialect: 'openai' | 'gemini' | 'anthropic' | 'other' };
  reasoning?: { controls: Array<'effort' | 'budget_tokens' | 'level'>; returnsSummary: boolean; statefulItems: boolean };
  caching: { kind: 'implicit' | 'explicit' | 'none'; minTokens?: number; discount?: number };
  /** USD per 1M tokens. `null` when Helix has no verified price for the model. */
  pricing: { inputPerM: number; cachedInputPerM?: number; outputPerM: number; asOf: string; note?: string } | null;
  limits?: { rpm?: number; tpm?: number };
  /** 'bundled' = Helix overlay only; 'live' = confirmed by the provider's models endpoint. */
  origin: 'bundled' | 'live' | 'live+bundled';
}

export interface TokenCount {
  inputTokens: number;
  exact: boolean;
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'safety'
  | 'transient'
  | 'plan_limit'
  | 'invalid_request'
  | 'cancelled'
  | 'fatal';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(provider: string, kind: ProviderErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limit';
  }
}

export interface ProviderAdapter {
  readonly id: string;
  /** Live model list merged with the bundled overlay; falls back to the bundled manifest. */
  listModels(auth: AuthContext): Promise<ModelManifest[]>;
  bundledModels(): ModelManifest[];
  defaultModel: string;
  stream(req: ModelRequest, auth: AuthContext, signal: AbortSignal): AsyncIterable<StreamEvent>;
  countTokens(req: ModelRequest, auth?: AuthContext): Promise<TokenCount>;
  normalizeError(error: unknown): ProviderError;
}

/** Deterministic estimator used when a provider has no exact counting API (~4 chars per token). */
export function estimateTokens(req: Pick<ModelRequest, 'system' | 'messages' | 'tools'>): number {
  let chars = (req.system ?? '').length;
  for (const m of req.messages) {
    for (const p of m.parts) {
      if (p.type === 'text') chars += p.text.length;
      else if (p.type === 'tool_call') chars += p.name.length + JSON.stringify(p.args ?? null).length;
      else if (p.type === 'tool_result') chars += p.content.length + p.name.length;
      else if (p.type === 'reasoning') chars += (p.summary ?? '').length;
    }
    chars += 8;
  }
  for (const t of req.tools ?? []) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4);
}

export function emptyUsage(source: Usage['source'] = 'provider'): Usage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, source };
}
