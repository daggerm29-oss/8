import { ProviderError, type AuthContext, type ModelRequest, type ProviderAdapter, type StreamEvent } from './models.ts';

export interface RetryPolicy {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Shared backoff (gateway §27.1 and the conformance suite): honor Retry-After, else jittered exponential. */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, policy: RetryPolicy = {}): number {
  const base = policy.baseDelayMs ?? 500;
  const max = policy.maxDelayMs ?? 20_000;
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, max);
  const exp = base * 2 ** attempt;
  return Math.min(max, Math.round(exp / 2 + Math.random() * (exp / 2)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Stream with retry on rate_limit/transient errors raised before the first event (so no delta is
 * ever replayed twice). Errors after output has started propagate to the caller.
 */
export async function* streamWithRetry(
  adapter: ProviderAdapter,
  req: ModelRequest,
  auth: AuthContext,
  signal: AbortSignal,
  policy: RetryPolicy & { onRetry?: (e: ProviderError, attempt: number, delayMs: number) => void } = {},
): AsyncGenerator<StreamEvent> {
  const maxRetries = policy.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      for await (const e of adapter.stream(req, auth, signal)) {
        started = true;
        yield e;
      }
      return;
    } catch (error) {
      const e = adapter.normalizeError(error);
      if (started || !e.retryable || attempt >= maxRetries || signal.aborted) throw e;
      const delay = retryDelayMs(attempt, e.retryAfterMs, policy);
      policy.onRetry?.(e, attempt, delay);
      try {
        await sleep(delay, signal);
      } catch {
        throw new ProviderError(adapter.id, 'cancelled', 'request aborted during retry backoff');
      }
    }
  }
}
