import { refString, type ModelRef } from './roles.ts';

/**
 * Model router v1 (F-MDL-5, §7.6): a deterministic rule table maps the agent-loop step type to a tier
 * (S small/fast, M mid, L strong), then orders the role's chain by tier distance (ties keep the
 * configured order). One-tier escalation after a failed verification gate; refs whose circuit breaker
 * is open move to the end. The decision and its rationale go into the ledger's `router_reason`.
 */

export type Tier = 'S' | 'M' | 'L';
export type StepType = 'plan' | 'edit' | 'explore' | 'summarize';

const TIERS: readonly Tier[] = ['S', 'M', 'L'];

export const STEP_TIER: Record<StepType, Tier> = { plan: 'L', edit: 'M', explore: 'S', summarize: 'S' };

/** Name-token heuristic: lite/mini/nano/haiku/small → S; pro/opus/ultra/large → L; everything else M. */
export function tierOf(model: string): Tier {
  const tokens = model.toLowerCase().split(/[-_.:/@\s]+/);
  if (tokens.some((t) => ['lite', 'mini', 'nano', 'haiku', 'small'].includes(t))) return 'S';
  if (tokens.some((t) => ['pro', 'opus', 'ultra', 'large'].includes(t))) return 'L';
  return 'M';
}

export interface RouteInput {
  step: StepType;
  chain: ModelRef[];
  /** Failed verification gates so far in this task. */
  gateFailures?: number;
  isOpen?: (ref: ModelRef) => boolean;
}

export interface RouteDecision { tier: Tier; refs: ModelRef[]; reason: string; escalated: boolean }

export function route(input: RouteInput): RouteDecision {
  const base = STEP_TIER[input.step];
  const escalated = input.step === 'edit' && (input.gateFailures ?? 0) > 0 && base !== 'L';
  const tier = escalated ? TIERS[TIERS.indexOf(base) + 1] : base;
  const want = TIERS.indexOf(tier);
  const ranked = input.chain
    .map((ref, i) => ({ ref, i, dist: Math.abs(TIERS.indexOf(tierOf(ref.model)) - want), open: input.isOpen?.(ref) ?? false }))
    .sort((a, b) => Number(a.open) - Number(b.open) || a.dist - b.dist || a.i - b.i);
  const refs = ranked.map((r) => r.ref);
  const open = ranked.filter((r) => r.open).map((r) => refString(r.ref));
  const parts = [`step=${input.step} tier=${tier}`];
  if (escalated) parts.push(`escalated ${base}→${tier} after failed gate (${input.gateFailures})`);
  if (refs[0]) parts.push(`pick ${refString(refs[0])} [${tierOf(refs[0].model)}]`);
  if (open.length) parts.push(`circuit open: ${open.join(', ')}`);
  return { tier, refs, reason: parts.join('; '), escalated };
}
