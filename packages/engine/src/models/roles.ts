import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRole } from './ledger.ts';

/**
 * Role-based model configuration (F-MDL-4, §7.5). Settings layers, lowest to highest precedence:
 * user (`$HELIX_HOME/models.json`) < workspace (`<ws>/.helix/models.json`) < task override. Org policy
 * (`$HELIX_HOME/policy.json`) is applied last: denied refs are dropped from every chain (deny wins over
 * allow) and `forced` replaces a role's binding outright.
 */

export const MODEL_ROLES: readonly ModelRole[] = ['planner', 'coder', 'explorer', 'reviewer', 'debugger', 'summarizer', 'embedder', 'completion', 'router'];

export interface ModelRef { provider: string; model: string }
export type RefInput = string | ModelRef;
export interface RoleBindingInput { primary: RefInput; fallbacks?: RefInput[] }
export type RolesInput = Partial<Record<ModelRole, RefInput | RoleBindingInput>>;
export interface ModelsConfig { roles?: RolesInput }

export interface ModelPolicy {
  allowProviders?: string[];
  denyProviders?: string[];
  /** `provider/model` globs (`*` wildcard). */
  allowModels?: string[];
  denyModels?: string[];
  forced?: RolesInput;
}

export type BindingSource = 'default' | 'user' | 'workspace' | 'task' | 'policy';
export interface ResolvedBinding { role: ModelRole; chain: ModelRef[]; source: BindingSource; dropped: Array<{ ref: string; reason: string }> }
export type ResolvedRoles = Record<ModelRole, ResolvedBinding>;

export class ModelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPolicyError';
  }
}

export const refString = (r: ModelRef): string => `${r.provider}/${r.model}`;

export function parseRef(input: RefInput, defaultProvider?: string): ModelRef {
  if (typeof input === 'object' && input && typeof input.provider === 'string' && typeof input.model === 'string' && input.provider && input.model) {
    return { provider: input.provider, model: input.model };
  }
  if (typeof input !== 'string' || !input.trim()) throw new ModelPolicyError(`invalid model ref: ${JSON.stringify(input)}`);
  const s = input.trim();
  const i = s.search(/[/:]/);
  if (i > 0) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  if (!defaultProvider) throw new ModelPolicyError(`model ref '${s}' needs a provider (use provider/model)`);
  return { provider: defaultProvider, model: s };
}

function bindingOf(v: RefInput | RoleBindingInput, defaultProvider?: string): ModelRef[] {
  if (typeof v === 'object' && v && 'primary' in v) {
    return [parseRef(v.primary, defaultProvider), ...(v.fallbacks ?? []).map((f) => parseRef(f, defaultProvider))];
  }
  return [parseRef(v as RefInput, defaultProvider)];
}

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/** Why a ref is forbidden by policy, or null when allowed. */
export function policyVerdict(ref: ModelRef, policy: ModelPolicy | undefined): string | null {
  if (!policy) return null;
  const s = refString(ref);
  if (policy.denyProviders?.includes(ref.provider)) return `provider '${ref.provider}' is denied by org policy`;
  if (policy.denyModels?.some((g) => globToRe(g).test(s))) return `model '${s}' is denied by org policy`;
  if (policy.allowProviders && !policy.allowProviders.includes(ref.provider)) return `provider '${ref.provider}' is not in the org allow list`;
  if (policy.allowModels && !policy.allowModels.some((g) => globToRe(g).test(s))) return `model '${s}' is not in the org allow list`;
  return null;
}

function validateRoles(input: unknown, where: string): RolesInput {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ModelPolicyError(`${where}: roles must be an object`);
  for (const k of Object.keys(input)) if (!MODEL_ROLES.includes(k as ModelRole)) throw new ModelPolicyError(`${where}: unknown role '${k}' (known: ${MODEL_ROLES.join(', ')})`);
  return input as RolesInput;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ModelPolicyError(`${path}: invalid JSON (${(e as Error).message})`);
  }
}

export interface RoleLayers { user: RolesInput; workspace: RolesInput; policy?: ModelPolicy }

export function loadRoleLayers(home: string | undefined, workspaceRoot: string): RoleLayers {
  const user = home ? (readJson(join(home, 'models.json')) as ModelsConfig | undefined) : undefined;
  const ws = readJson(join(workspaceRoot, '.helix', 'models.json')) as ModelsConfig | undefined;
  const pol = home ? (readJson(join(home, 'policy.json')) as { models?: ModelPolicy } | undefined) : undefined;
  const policy = pol?.models;
  if (policy?.forced) validateRoles(policy.forced, 'policy.json models.forced');
  return { user: validateRoles(user?.roles, 'models.json'), workspace: validateRoles(ws?.roles, '.helix/models.json'), policy };
}

/**
 * Resolve every role. `base` is the task's default (CLI `-m`/provider default); an explicit task model
 * counts as a task-level `coder` override. Unset roles inherit coder's chain.
 */
export function resolveRoles(base: ModelRef, layers: RoleLayers, task: RolesInput = {}, explicitTaskModel = false): ResolvedRoles {
  const taskRoles = validateRoles(task, 'task roles');
  const pick = (role: ModelRole): { chain: ModelRef[]; source: BindingSource } | null => {
    const forced = layers.policy?.forced?.[role];
    if (forced) return { chain: bindingOf(forced, base.provider), source: 'policy' };
    if (taskRoles[role]) return { chain: bindingOf(taskRoles[role]!, base.provider), source: 'task' };
    if (role === 'coder' && explicitTaskModel) return { chain: [base], source: 'task' };
    if (layers.workspace[role]) return { chain: bindingOf(layers.workspace[role]!, base.provider), source: 'workspace' };
    if (layers.user[role]) return { chain: bindingOf(layers.user[role]!, base.provider), source: 'user' };
    return null;
  };
  const coder = pick('coder') ?? { chain: [base], source: 'default' as const };
  const out = {} as ResolvedRoles;
  for (const role of MODEL_ROLES) {
    const p = role === 'coder' ? coder : pick(role) ?? { chain: coder.chain, source: coder.source === 'policy' ? 'policy' : 'default' as BindingSource };
    const dropped: ResolvedBinding['dropped'] = [];
    const seen = new Set<string>();
    const chain = p.chain.filter((r) => {
      const key = refString(r);
      if (seen.has(key)) return false;
      seen.add(key);
      const why = policyVerdict(r, layers.policy);
      if (why) dropped.push({ ref: key, reason: why });
      return !why;
    });
    out[role] = { role, chain, source: p.source, dropped };
  }
  return out;
}

/** Throws when a role the task needs has no model left after policy filtering. */
export function assertUsable(roles: ResolvedRoles, needed: ModelRole[]): void {
  for (const role of needed) {
    const b = roles[role];
    if (!b.chain.length) throw new ModelPolicyError(`no allowed model for role '${role}': ${b.dropped.map((d) => d.reason).join('; ') || 'empty chain'}`);
  }
}

/** Parse CLI `--role role=provider/model[,fallback...]` entries. */
export function parseRoleFlags(flags: string[]): RolesInput {
  const out: RolesInput = {};
  for (const f of flags) {
    const eq = f.indexOf('=');
    if (eq <= 0) throw new ModelPolicyError(`--role expects role=provider/model, got '${f}'`);
    const role = f.slice(0, eq).trim() as ModelRole;
    if (!MODEL_ROLES.includes(role)) throw new ModelPolicyError(`unknown role '${role}' (known: ${MODEL_ROLES.join(', ')})`);
    const [primary, ...fallbacks] = f.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!primary) throw new ModelPolicyError(`--role ${role}= needs a model`);
    out[role] = { primary, fallbacks };
  }
  return out;
}
