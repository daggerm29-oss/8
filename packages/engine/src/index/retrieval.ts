import { identifierTerms } from './extract.ts';

/** One fused candidate shown to a reranker (§11.6). `text` is the slice body, truncated by the caller. */
export interface RerankCandidate {
  path: string;
  symbol: string | null;
  text: string;
}

/** Scores candidates in [0, 1] for a query. A local cross-encoder (M2) or a Tier-S LLM listwise call plugs in here. */
export type Reranker = (query: string, candidates: RerankCandidate[]) => number[];

const presence = (terms: string[], haystack: Set<string>): number => (terms.length ? terms.filter((t) => haystack.has(t)).length / terms.length : 0);
const termSet = (text: string): Set<string> => new Set(identifierTerms(text).split(' ').filter(Boolean));

/**
 * Deterministic local reranker: query-term coverage of the symbol name, the path and the slice body, with a bonus
 * when every term appears in the body. It reads the whole candidate (unlike the first-stage retrievers, which score
 * fields independently), which is what separates near-ties.
 */
export const localReranker = (terms: string[]): Reranker => (_query, candidates) =>
  candidates.map((c) => {
    const body = termSet(c.text);
    const bodyCoverage = presence(terms, body);
    const symbolCoverage = presence(terms, termSet(c.symbol ?? ''));
    const pathCoverage = presence(terms, termSet(c.path));
    const everyTerm = terms.length > 0 && bodyCoverage === 1 ? 1 : 0;
    return (3 * symbolCoverage + 2 * pathCoverage + 1.5 * bodyCoverage + 0.5 * everyTerm) / 7;
  });

/** Rerank only when the first-stage scores do not already single out a winner (§11.6 "top-k scores are close"). */
export function isAmbiguous(scoresDescending: number[], relativeGap = 0.12): boolean {
  if (scoresDescending.length < 3 || scoresDescending[0] <= 0) return false;
  return (scoresDescending[0] - scoresDescending[1]) / scoresDescending[0] < relativeGap;
}

export interface Slice {
  path: string;
  start: number;
  end: number;
  symbol: string | null;
  score: number;
  why: Set<string>;
}

/** Merge slices of one file that overlap or sit within `gap` lines of each other; the best-ranked slice leads. */
export function mergeAdjacent<T extends Slice>(rankedSlices: T[], gap = 3): T[] {
  const kept: T[] = [];
  for (const slice of rankedSlices) {
    const neighbor = kept.find((k) => k.path === slice.path && slice.start <= k.end + gap + 1 && slice.end >= k.start - gap - 1);
    if (!neighbor) { kept.push({ ...slice, why: new Set(slice.why) }); continue; }
    neighbor.start = Math.min(neighbor.start, slice.start);
    neighbor.end = Math.max(neighbor.end, slice.end);
    neighbor.score += slice.score;
    for (const w of slice.why) neighbor.why.add(w);
    if (!neighbor.symbol && slice.symbol) neighbor.symbol = slice.symbol;
  }
  return kept;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
