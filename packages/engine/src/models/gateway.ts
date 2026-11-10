import {
  ProviderError,
  estimateTokens,
  emptyUsage,
  retryDelayMs,
  type FinishReason,
  type Message,
  type ModelManifest,
  type ModelRequest,
  type ProviderAdapter,
  type StreamEvent,
  type Usage,
} from '@helix/protocol';
import type { Vault } from '../vault/vault.ts';
import type { Tracer } from '../obs/tracing.ts';
import type { Logger } from '../util/log.ts';
import { attributeRequest, costOf, type Ledger, type ModelRole, type ReconcileReport } from './ledger.ts';

export class BudgetExceededError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'BudgetExceededError';
    this.reason = reason;
  }
}

export interface GatewayCall {
  provider: string;
  model: string;
  role: ModelRole;
  request: Omit<ModelRequest, 'model'>;
  ws?: string;
  task?: string;
  agent?: string;
  step?: string;
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
  contextBreakdown?: Record<string, number>;
  toolTokens?: Record<string, number>;
  routerReason?: string;
}

export interface GatewayResult {
  message: Message;
  usage: Usage;
  finishReason: FinishReason;
  responseId?: string;
  ledgerEntryId: string;
  costUsd: number | null;
  attempts: number;
  latencyMs: number;
}

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  /** Outcomes within the error-rate window. */
  window: Array<{ at: number; ok: boolean }>;
}

export interface GatewayOptions {
  adapters: ProviderAdapter[];
  vault: Vault;
  ledger: Ledger;
  tracer: Tracer;
  logger?: Logger;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  breaker?: { threshold?: number; cooldownMs?: number; windowMs?: number; minCalls?: number; errorRate?: number };
}

/**
 * Model Gateway (§7, §27.1): budget pre-check → circuit breaker → stream → jittered retry (≤ 2) on
 * transient/rate-limit errors → ledger entry per attempt (with the router's rationale) → OTel span.
 * The breaker is per (provider, model): it opens on `threshold` consecutive failures or an error rate
 * ≥ `errorRate` over `windowMs` (at least `minCalls` outcomes) and half-opens after `cooldownMs`.
 */
export class ModelGateway {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly vault: Vault;
  private readonly ledger: Ledger;
  private readonly tracer: Tracer;
  private readonly logger?: Logger;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly breakerWindowMs: number;
  private readonly breakerMinCalls: number;
  private readonly breakerErrorRate: number;
  private readonly breakers = new Map<string, BreakerState>();
  private readonly liveManifests = new Map<string, ModelManifest>();

  constructor(opts: GatewayOptions) {
    for (const a of opts.adapters) this.adapters.set(a.id, a);
    this.vault = opts.vault;
    this.ledger = opts.ledger;
    this.tracer = opts.tracer;
    this.logger = opts.logger;
    this.maxRetries = opts.retry?.maxRetries ?? 2;
    this.baseDelayMs = opts.retry?.baseDelayMs ?? 500;
    this.maxDelayMs = opts.retry?.maxDelayMs ?? 20_000;
    this.breakerThreshold = opts.breaker?.threshold ?? 5;
    this.breakerCooldownMs = opts.breaker?.cooldownMs ?? 30_000;
    this.breakerWindowMs = opts.breaker?.windowMs ?? 60_000;
    this.breakerMinCalls = opts.breaker?.minCalls ?? 4;
    this.breakerErrorRate = opts.breaker?.errorRate ?? 0.5;
  }

  /** Ledger vs provider-reported usage (re-derived from raw usage metadata by each adapter) and attribution check. */
  reconcile(filter: { task?: string; ws?: string; since?: string; tolerancePct?: number } = {}): ReconcileReport {
    return this.ledger.reconcile({
      ...filter,
      normalizeUsage: (provider, raw) => this.adapters.get(provider)?.normalizeUsage?.(raw),
      pricing: (provider, model) => this.manifest(provider, model)?.pricing,
    });
  }

  /** True while the breaker for this (provider, model) is open and still cooling down. */
  isOpen(provider: string, model: string): boolean {
    const b = this.breakers.get(`${provider}:${model}`);
    return !!b && b.openedAt !== null && Date.now() - b.openedAt < this.breakerCooldownMs;
  }

  private recordOutcome(b: BreakerState, ok: boolean): void {
    const now = Date.now();
    b.window = b.window.filter((x) => now - x.at < this.breakerWindowMs);
    b.window.push({ at: now, ok });
    if (ok) {
      b.consecutiveFailures = 0;
      return;
    }
    b.consecutiveFailures++;
    const failures = b.window.filter((x) => !x.ok).length;
    const rateTrip = b.window.length >= this.breakerMinCalls && failures / b.window.length >= this.breakerErrorRate;
    if (b.consecutiveFailures >= this.breakerThreshold || rateTrip) {
      b.openedAt = now;
      b.window = [];
    }
  }

  adapter(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new ProviderError(id, 'invalid_request', `unknown provider '${id}' (available: ${[...this.adapters.keys()].join(', ')})`);
    return a;
  }

  providers(): Array<{ id: string; configured: boolean; defaultModel: string }> {
    return [...this.adapters.values()].filter((a) => a.id !== 'replay').map((a) => ({ id: a.id, configured: this.vault.isConfigured(a.id), defaultModel: a.defaultModel }));
  }

  defaultProvider(): string {
    const configured = this.providers().find((p) => p.configured);
    return configured?.id ?? [...this.adapters.keys()][0];
  }

  manifest(provider: string, model: string): ModelManifest | undefined {
    return this.liveManifests.get(`${provider}:${model}`) ?? this.adapter(provider).bundledModels().find((m) => m.id === model);
  }

  async listModels(provider: string): Promise<ModelManifest[]> {
    const models = await this.adapter(provider).listModels(this.vault.providerAuth(provider));
    for (const m of models) this.liveManifests.set(`${provider}:${m.id}`, m);
    return models;
  }

  private breaker(key: string): BreakerState {
    let b = this.breakers.get(key);
    if (!b) {
      b = { consecutiveFailures: 0, openedAt: null, window: [] };
      this.breakers.set(key, b);
    }
    return b;
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    return retryDelayMs(attempt, retryAfterMs, { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs });
  }

  async call(c: GatewayCall): Promise<GatewayResult> {
    const adapter = this.adapter(c.provider);
    const auth = this.vault.providerAuth(c.provider);
    const req: ModelRequest = { ...c.request, model: c.model };
    const manifest = this.manifest(c.provider, c.model);
    // FR-31: every call is attributed (tool result tokens + context split), whether or not the caller supplied it.
    const attribution = attributeRequest(req);
    const toolTokens = c.toolTokens ?? attribution.toolTokens;
    const contextBreakdown = c.contextBreakdown ?? attribution.contextBreakdown;
    const estInput = estimateTokens(req);
    const estOutput = Math.min(req.maxOutputTokens ?? 4096, 4096);
    const decision = this.ledger.check({ task: c.task, ws: c.ws, estimateUsd: costOf(manifest?.pricing, { inputTokens: estInput, cachedInputTokens: 0, outputTokens: estOutput }), estimateTokens: estInput + estOutput });
    if (decision.decision === 'deny') throw new BudgetExceededError(decision.reason ?? 'budget exceeded');

    const key = `${c.provider}:${c.model}`;
    const breaker = this.breaker(key);
    let attempt = 0;
    while (true) {
      if (breaker.openedAt !== null) {
        if (Date.now() - breaker.openedAt < this.breakerCooldownMs) {
          throw new ProviderError(c.provider, 'transient', `circuit open for ${key}`);
        }
        breaker.openedAt = null; // half-open: allow one probe
      }
      const started = performance.now();
      try {
        const result = await this.tracer.withSpan('model.call', { provider: c.provider, model: c.model, role: c.role, attempt, 'task.id': c.task ?? '', 'step.id': c.step ?? '' }, async (span) => {
          let final: Extract<StreamEvent, { type: 'done' }> | undefined;
          for await (const e of adapter.stream(req, auth, c.signal ?? new AbortController().signal)) {
            if (e.type === 'done') final = e;
            else {
              if (e.type === 'notice') {
                // F-MDL-1 AC3: every degradation is logged and visible on the model.call span.
                span.addEvent('capability.degraded', { feature: e.feature, detail: e.detail });
                this.logger?.info('capability degraded', { provider: c.provider, model: c.model, feature: e.feature, detail: e.detail, task: c.task });
              }
              c.onEvent?.(e);
            }
          }
          if (!final) throw new ProviderError(c.provider, 'transient', 'stream ended without a final event');
          span.setAttributes({ 'usage.input_tokens': final.usage.inputTokens, 'usage.cached_input_tokens': final.usage.cachedInputTokens, 'usage.output_tokens': final.usage.outputTokens, 'usage.source': final.usage.source, finish_reason: final.finishReason });
          return final;
        });
        const latencyMs = performance.now() - started;
        const entry = this.ledger.record({
          ws: c.ws, task: c.task, agent: c.agent, step: c.step, role: c.role, provider: c.provider, model: c.model, usage: result.usage, latencyMs,
          status: 'ok', providerResponseId: result.responseId, contextBreakdown, toolTokens, routerReason: c.routerReason,
        }, manifest?.pricing);
        this.recordOutcome(breaker, true);
        return { message: result.message, usage: result.usage, finishReason: result.finishReason, responseId: result.responseId, ledgerEntryId: entry.id, costUsd: entry.costUsd, attempts: attempt + 1, latencyMs };
      } catch (error) {
        const e = adapter.normalizeError(error);
        const latencyMs = performance.now() - started;
        this.ledger.record({ ws: c.ws, task: c.task, agent: c.agent, step: c.step, role: c.role, provider: c.provider, model: c.model, usage: emptyUsage('estimate'), latencyMs, status: e.kind === 'cancelled' ? 'cancelled' : 'error', error: `${e.kind}: ${e.message}`, routerReason: c.routerReason, contextBreakdown, toolTokens }, manifest?.pricing);
        if (e.kind === 'cancelled') throw e;
        this.recordOutcome(breaker, false);
        if (breaker.openedAt !== null || !e.retryable || attempt >= this.maxRetries) throw e;
        const delay = this.backoff(attempt, e.retryAfterMs);
        this.logger?.warn('model call failed; retrying', { provider: c.provider, model: c.model, kind: e.kind, attempt, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
      }
    }
  }
}
