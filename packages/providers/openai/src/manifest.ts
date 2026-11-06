import type { ModelManifest } from '@helix/protocol';

const reasoningModel = {
  provider: 'openai',
  status: 'stable' as const,
  contextWindow: 400_000,
  maxOutput: 128_000,
  modalities: { input: ['text', 'image', 'pdf'] as Array<'text' | 'image' | 'pdf'>, output: ['text'] as Array<'text'> },
  tools: { supported: true, parallel: true, strictSchema: true, dialect: 'openai' as const },
  reasoning: { controls: ['effort'] as Array<'effort'>, returnsSummary: true, statefulItems: true },
  caching: { kind: 'implicit' as const, minTokens: 1024, discount: 0.9 },
  origin: 'bundled' as const,
};

/** Bundled overlay (§7.4). Prices are standard-tier USD per 1M tokens as of 2026-11-06. */
export const OPENAI_MODELS: ModelManifest[] = [
  { ...reasoningModel, id: 'gpt-5', displayName: 'GPT-5', pricing: { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0, asOf: '2026-11-06' } },
  { ...reasoningModel, id: 'gpt-5-mini', displayName: 'GPT-5 mini', pricing: { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0, asOf: '2026-11-06' } },
  { ...reasoningModel, id: 'gpt-5-nano', displayName: 'GPT-5 nano', pricing: { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4, asOf: '2026-11-06' } },
];

export const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';

/** Heuristic capability for live models absent from the overlay: GPT-5 and o-series are reasoning models. */
export function isReasoningModelId(id: string): boolean {
  return /^(gpt-5|o\d)/.test(id);
}
