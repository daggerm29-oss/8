/**
 * Plan review (FR-12, F-AGT-2, Arch §9.4): the user edits and approves the plan artifact a Plan Mode task
 * produced. Pure validation lives here; persistence and the execution hand-off live in AgentRuntime.
 */
export interface PlanStep {
  id: string;
  description: string;
  writeSet: string[];
  dependsOn: string[];
  gates: string[];
}

export interface PlanEdit {
  goal?: string;
  assumptions?: string[];
  steps?: unknown;
  risks?: string[];
  verification?: string[];
  openQuestions?: string[];
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${field} must be an array of strings`);
  return value.map((v) => v.trim()).filter(Boolean);
}

/** A step may only name workspace-relative paths; the approved write set is a security boundary, not a hint. */
function relativeWorkspacePath(path: string): boolean {
  return !path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path) && !path.split(/[\\/]/).includes('..') && !path.includes('\0');
}

export function normalizeSteps(input: unknown): PlanStep[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('steps must be a non-empty array');
  const steps = input.map((raw, i): PlanStep => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    const description = typeof s.description === 'string' ? s.description.trim() : '';
    if (!id) throw new Error(`step ${i + 1} needs an id`);
    if (!description) throw new Error(`step ${id} needs a description`);
    const writeSet = strings(s.writeSet, `step ${id}.writeSet`);
    const bad = writeSet.find((p) => !relativeWorkspacePath(p));
    if (bad) throw new Error(`step ${id}.writeSet must be workspace-relative paths (got ${bad})`);
    return { id, description, writeSet, dependsOn: strings(s.dependsOn, `step ${id}.dependsOn`), gates: strings(s.gates, `step ${id}.gates`) };
  });
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`duplicate step id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of steps) {
    const missing = s.dependsOn.find((d) => !ids.has(d));
    if (missing) throw new Error(`step ${s.id} depends on unknown step ${missing}`);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`step dependencies form a cycle at ${id}`);
    state.set(id, 1);
    for (const d of steps.find((s) => s.id === id)!.dependsOn) visit(d);
    state.set(id, 2);
  };
  for (const s of steps) visit(s.id);
  return steps;
}

/** Applies a user edit to a plan artifact payload, returning the next revision's data. */
export function applyPlanEdit(previous: Record<string, unknown>, edit: PlanEdit): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  if (edit.goal !== undefined) {
    if (typeof edit.goal !== 'string' || !edit.goal.trim()) throw new Error('goal must be a non-empty string');
    next.goal = edit.goal.trim();
  }
  for (const key of ['assumptions', 'risks', 'verification', 'openQuestions'] as const) {
    if (edit[key] !== undefined) next[key] = strings(edit[key], key);
  }
  next.steps = normalizeSteps(edit.steps !== undefined ? edit.steps : previous.steps);
  if (!Array.isArray(next.verification) || next.verification.length === 0) throw new Error('verification must list at least one check');
  return next;
}

/** Prompt text for the execution task: the approved plan is the user's instruction, in order. */
export function approvedPlanPrompt(plan: Record<string, unknown>): string {
  const steps = (plan.steps as PlanStep[]).map((s, i) => {
    const deps = s.dependsOn.length ? ` (after ${s.dependsOn.join(', ')})` : '';
    const writes = s.writeSet.length ? ` [files: ${s.writeSet.join(', ')}]` : '';
    return `${i + 1}. ${s.id}: ${s.description}${deps}${writes}`;
  });
  const lines = [String(plan.goal), '', 'The user reviewed and approved this plan. Carry it out step by step.', ...steps];
  const verification = (plan.verification as string[] | undefined) ?? [];
  if (verification.length) lines.push('', `Verification: ${verification.join('; ')}`);
  return lines.join('\n');
}
