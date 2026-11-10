import type { HelixEvent } from '@helix/protocol';

/** The audit coverage of architecture §26.5 (F-OBS-3, SEC-9). Every other audited topic is recorded under `system`. */
export const AUDIT_CATEGORIES = ['approval', 'policy', 'trust', 'credential', 'git_push', 'deploy', 'mcp', 'budget'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** The §26.5 record fields that are not already columns of the event itself. They are covered by the hash. */
export interface AuditFields {
  category: AuditCategory | 'system';
  actor: string;
  action: string;
  resource: string;
  decision: string | null;
  ruleId: string | null;
}

type Data = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Who did it: a user action, an agent task, or the Engine itself. */
function actorOf(e: HelixEvent, d: Data): string {
  const by = str(d.by) ?? str(d.decidedBy);
  if (by) return by === 'user' ? 'user' : by;
  return e.task ? `agent:${e.task}` : 'system';
}

/**
 * Maps an audited event to its §26.5 record fields. Pure and deterministic: the result is what the hash chain commits to, so
 * changing this mapping changes how future rows are recorded, never how existing rows verify.
 */
export function auditFields(e: HelixEvent): AuditFields {
  const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Data;
  const actor = actorOf(e, d);
  const f = (category: AuditFields['category'], action: string, resource: string, decision: string | null = null, ruleId: string | null = null): AuditFields => ({ category, actor, action, resource, decision, ruleId });
  switch (e.topic) {
    case 'approval.requested': return f('approval', 'requested', str(d.tool) ?? 'tool', 'pending', str(d.actionClass));
    case 'approval.decided': return f('approval', d.approved ? 'approved' : 'denied', str(d.tool) ?? 'tool', d.approved ? 'allow' : 'deny', str(d.actionClass));
    case 'approval.replayed': return f('approval', 'replayed', str(d.tool) ?? 'tool', d.approved ? 'allow' : 'deny', str(d.actionClass));
    case 'tool.result': return f('approval', 'tool_denied', str(d.tool) ?? 'tool', 'deny', str(d.actionClass));
    case 'policy.changed': return f('policy', str(d.change) ?? 'changed', str(d.subject) ?? 'policy', null, str(d.policyProfile));
    case 'egress.allowed': return f('policy', 'egress_allowed', str(d.host) ?? 'host', 'allow');
    case 'egress.denied': return f('policy', 'egress_denied', str(d.host) ?? 'host', 'deny', str(d.reason));
    case 'workspace.trust_changed': return f('trust', d.trusted ? 'trusted' : 'untrusted', str(d.workspacePath) ?? 'workspace', d.trusted ? 'allow' : 'deny', d.lightMode ? 'light_mode' : null);
    case 'sandbox.light_mode': return f('trust', 'light_mode_sandbox', str(d.workspacePath) ?? 'workspace', 'allow', str(d.tool));
    case 'secret.bound': return f('credential', 'bound', str(d.name) ?? 'secret');
    case 'secret.used': return f('credential', 'injected', str(d.name) ?? 'secret', 'allow', str(d.host));
    case 'secret.exfil_attempt': return f('credential', 'exfil_blocked', str(d.secret) ?? 'secret', 'deny', str(d.host));
    case 'vault.key_set': return f('credential', 'key_set', str(d.provider) ?? 'provider');
    case 'vault.key_deleted': return f('credential', 'key_deleted', str(d.provider) ?? 'provider');
    case 'git.push': return f('git_push', 'push', str(d.target) ?? 'git', str(d.decision), str(d.reason));
    case 'deploy.requested': return f('deploy', 'deploy', str(d.target) ?? 'deploy', str(d.decision), str(d.reason));
    case 'mcp.server_added': return f('mcp', 'server_added', str(d.server) ?? 'server', null, str(d.trust));
    case 'mcp.server_removed': return f('mcp', 'server_removed', str(d.server) ?? 'server');
    case 'mcp.trust_changed': return f('mcp', 'trust_changed', str(d.server) ?? 'server', null, str(d.to));
    case 'budget.override': return f('budget', 'override', `${str(d.scope) ?? 'budget'}:${str(d.scopeId) ?? ''}`);
    case 'budget.threshold': return f('budget', str(d.kind) ?? 'threshold', str(d.budgetId) ?? 'budget', str(d.decision));
    default: return f('system', e.topic.split('.').slice(1).join('.') || e.topic, str(d.tool) ?? str(d.workspacePath) ?? e.task ?? e.ws);
  }
}

/** Command intents that §26.5 audits even though the agent has no dedicated tool for them. */
export function auditIntentOf(tool: string, args: unknown): { category: 'git_push' | 'deploy'; target: string } | null {
  if (tool !== 'run_shell') return null;
  const command = String((args as { command?: unknown })?.command ?? '');
  const push = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b([^;&|\n]*)/.exec(command);
  if (push) return { category: 'git_push', target: push[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-')).join(' ') || 'default remote' };
  const deploy = /\b(vercel(?:\s+\S+)*?\s+(?:deploy|--prod)|netlify\s+deploy|(?:fly|flyctl)\s+deploy|wrangler\s+(?:deploy|publish)|firebase\s+deploy|kubectl\s+(?:apply|rollout)|helm\s+(?:install|upgrade)|serverless\s+deploy|sls\s+deploy|(?:npm|pnpm|yarn)\s+publish|docker\s+push)\b/.exec(command);
  if (deploy) return { category: 'deploy', target: deploy[1].replace(/\s+/g, ' ') };
  return null;
}
