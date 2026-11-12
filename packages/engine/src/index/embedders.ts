/**
 * Embedding backends for F-IDX-6 (§12.3). Three interchangeable embedders sit behind one interface:
 *  - `localSemanticEmbedder`: bundled-by-pin local model (all-MiniLM-L6-v2, int8, Apache-2.0, 384 dims) run with
 *    ONNX Runtime through @huggingface/transformers. Weights are fetched once, at a pinned revision, into a local cache.
 *  - `geminiEmbedder`: provider embeddings (`gemini-embedding-2`) over the Gemini REST API; the provider reports token usage.
 *  - `hashEmbedder`: `helix-local-hash-v1` signed feature hashing. Lexical, not semantic; the offline fallback only.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelManifest } from '@helix/protocol';
import { dot, embed, EMBED_DIM, EMBED_MODEL } from './embed.ts';

export type EmbedPurpose = 'document' | 'query';

export interface EmbedResult {
  vectors: Float32Array[];
  inputTokens: number;
  /** 'provider' when the backend reported usage, 'estimate' when tokens are approximated from characters. */
  usageSource: 'provider' | 'estimate';
}

export interface Embedder {
  /** Stored with every vector so models can coexist and be migrated. */
  id: string;
  provider: string;
  /** `lexical` vectors capture word shape only; `semantic` vectors capture meaning. */
  kind: 'semantic' | 'lexical';
  dim: number;
  pricing: ModelManifest['pricing'];
  embed(texts: string[], purpose: EmbedPurpose): Promise<EmbedResult>;
}

const estimateTokens = (texts: string[]) => texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
const ZERO_PRICE = { inputPerM: 0, outputPerM: 0, asOf: '2026-11-12', note: 'runs on this machine; no provider charge' };

export const hashEmbedder: Embedder = {
  id: EMBED_MODEL,
  provider: 'helix-local',
  kind: 'lexical',
  dim: EMBED_DIM,
  pricing: { ...ZERO_PRICE, note: 'offline lexical fallback (feature hashing); not a semantic model' },
  async embed(texts) {
    return { vectors: texts.map((t) => embed(t)), inputTokens: estimateTokens(texts), usageSource: 'estimate' };
  },
};

export const LOCAL_MODEL = { repo: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', dtype: 'q8', id: 'local:all-MiniLM-L6-v2-q8', dim: 384, license: 'Apache-2.0' } as const;

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
const extractors = new Map<string, Promise<FeatureExtractor>>();

function loadExtractor(cacheDir: string): Promise<FeatureExtractor> {
  let loading = extractors.get(cacheDir);
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      return (await pipeline('feature-extraction', LOCAL_MODEL.repo, { dtype: LOCAL_MODEL.dtype, revision: LOCAL_MODEL.revision })) as unknown as FeatureExtractor;
    })();
    extractors.set(cacheDir, loading);
    loading.catch(() => extractors.delete(cacheDir));
  }
  return loading;
}

export function localSemanticEmbedder(opts: { cacheDir?: string } = {}): Embedder {
  const cacheDir = opts.cacheDir ?? process.env.HELIX_MODEL_CACHE ?? join(homedir(), '.cache', 'helix', 'models');
  return {
    id: LOCAL_MODEL.id,
    provider: 'helix-local',
    kind: 'semantic',
    dim: LOCAL_MODEL.dim,
    pricing: ZERO_PRICE,
    async embed(texts) {
      const extract = await loadExtractor(cacheDir);
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const out = (await extract(texts.slice(i, i + 16), { pooling: 'mean', normalize: true })).tolist();
        for (const v of out) vectors.push(Float32Array.from(v));
      }
      return { vectors, inputTokens: estimateTokens(texts), usageSource: 'estimate' };
    },
  };
}

export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
/** Published Standard paid-tier text input price (ai.google.dev pricing, 2026-11-12); a reference valuation, not an invoice. */
export const GEMINI_EMBEDDING_PRICING = { inputPerM: 0.2, outputPerM: 0, asOf: '2026-11-12', note: 'Standard paid-tier text input; the free tier is free of charge' } as const;

export function geminiEmbedder(opts: { apiKey: string; model?: string; dim?: number; baseUrl?: string; fetchFn?: typeof fetch }): Embedder {
  const model = opts.model ?? GEMINI_EMBEDDING_MODEL;
  const dim = opts.dim ?? 768;
  const base = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const call = opts.fetchFn ?? fetch;
  return {
    id: `${model}@${dim}`,
    provider: 'gemini',
    kind: 'semantic',
    dim,
    pricing: GEMINI_EMBEDDING_PRICING,
    async embed(texts, purpose) {
      const vectors: Float32Array[] = [];
      let inputTokens = 0;
      let reported = true;
      for (let i = 0; i < texts.length; i += 64) {
        const batch = texts.slice(i, i + 64);
        const response = await call(`${base}/models/${model}:batchEmbedContents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType: purpose === 'query' ? 'CODE_RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              outputDimensionality: dim,
            })),
          }),
        });
        const body = (await response.json()) as { embeddings?: Array<{ values: number[] }>; usageMetadata?: { promptTokenCount?: number }; error?: { message: string } };
        if (!response.ok || !body.embeddings || body.embeddings.length !== batch.length) throw new Error(`${model} embedContents failed (${response.status}): ${body.error?.message ?? 'unexpected response'}`);
        for (const e of body.embeddings) vectors.push(normalize(Float32Array.from(e.values)));
        if (body.usageMetadata?.promptTokenCount === undefined) { reported = false; inputTokens += estimateTokens(batch); } else inputTokens += body.usageMetadata.promptTokenCount;
      }
      return { vectors, inputTokens, usageSource: reported ? 'provider' : 'estimate' };
    },
  };
}

function normalize(v: Float32Array): Float32Array {
  const norm = Math.sqrt(dot(v, v));
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * `HELIX_EMBEDDINGS`: `local` (bundled-by-pin model), `gemini` (provider embeddings, needs GEMINI_API) or `off`/unset.
 * Off by default so a model is never downloaded, and no code is sent to a provider, without an explicit choice.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv): Embedder | undefined {
  const choice = (env.HELIX_EMBEDDINGS ?? 'off').toLowerCase();
  if (choice === 'local') return localSemanticEmbedder({ cacheDir: env.HELIX_MODEL_CACHE });
  if (choice === 'gemini' && env.GEMINI_API) return geminiEmbedder({ apiKey: env.GEMINI_API, model: env.HELIX_EMBEDDING_MODEL, dim: env.HELIX_EMBEDDING_DIM ? Number(env.HELIX_EMBEDDING_DIM) : undefined });
  return undefined;
}
