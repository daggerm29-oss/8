import type { ModelManifest } from '@helix/protocol';

const base = {
  provider: 'gemini',
  modalities: { input: ['text', 'image', 'pdf'] as Array<'text' | 'image' | 'pdf'>, output: ['text'] as Array<'text'> },
  tools: { supported: true, parallel: true, strictSchema: false, dialect: 'gemini' as const },
  reasoning: { controls: ['level'] as Array<'level'>, returnsSummary: true, statefulItems: true },
  structuredOutput: { supported: true, strict: false },
  caching: { kind: 'implicit' as const },
  origin: 'bundled' as const,
};

/**
 * Bundled overlay (§7.3). Model IDs from ai.google.dev/gemini-api/docs/models (2026-10-28).
 * Prices are the published per-1M-token rates as of 2026-11-06; `null` means no verified price.
 */
export const GEMINI_MODELS: ModelManifest[] = [
  {
    ...base,
    id: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    status: 'stable',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    pricing: { inputPerM: 2.0, cachedInputPerM: 0.1, outputPerM: 10.0, asOf: '2026-11-06', note: 'introductory rate through 2026-11-30; $4.00/$20.00 from 2026-12-01' },
  },
  {
    ...base,
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    status: 'stable',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    pricing: { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 3.75, asOf: '2026-11-06', note: 'introductory rate through 2026-12-31; $1.50/$7.50 from 2027-01-01' },
  },
  { ...base, id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', status: 'stable', contextWindow: 1_048_576, maxOutput: 65_536, pricing: null },
  { ...base, id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', status: 'stable', contextWindow: 1_048_576, maxOutput: 65_536, pricing: null },
  { ...base, id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (preview)', status: 'preview', contextWindow: 1_048_576, maxOutput: 65_536, pricing: null },
];

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
