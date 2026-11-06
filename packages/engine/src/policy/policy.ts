/**
 * Policy engine v0 (F-ORC-4 subset, §10.5, §25.4). Every tool call is classified into an action class
 * and resolved to allow / ask / deny for the task's profile. In the headless profile (`helix -p`) an
 * `ask` resolves to `deny` unless the class or exact tool was preapproved (§5.7).
 */
export type ActionClass = 'read' | 'write' | 'exec' | 'network' | 'destructive';
export type PolicyProfile = 'headless' | 'interactive' | 'plan';
export type Verdict = 'allow' | 'ask' | 'deny';

export interface PolicyDecision {
  verdict: Verdict;
  actionClass: ActionClass;
  reason: string;
}

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\*|\.\.?)(\s|$)/, 'recursive delete of a root, home, or parent path'],
  [/\bgit\s+push\b/, 'git push publishes changes'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, 'discards uncommitted work'],
  [/\b(sudo|su)\s/, 'privilege escalation'],
  [/\b(mkfs|fdisk|shutdown|reboot)\b|\bdd\s+if=/, 'system-level destructive command'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork bomb'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishes a package'],
  [/\bchmod\s+-R\s+777\s+\//, 'recursive permission change on root'],
];

const NETWORK: Array<[RegExp, string]> = [
  [/(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, 'pipes a download into a shell'],
  [/\b(curl|wget|ssh|scp|rsync|nc|telnet)\b/, 'network client'],
  [/\b(npm|pnpm|yarn)\s+(install|i|add)\b|\bpip3?\s+install\b|\bcargo\s+install\b/, 'package install fetches from the network'],
];

const TOOL_CLASS: Record<string, ActionClass> = {
  read_file: 'read', list_dir: 'read', search: 'read', find_symbol: 'read', code_search: 'read', submit_plan: 'read',
  write_file: 'write', edit_file: 'write',
  run_shell: 'exec',
};

/** Dynamically registered tools (MCP, F-MCP-3 v0) declare their class here; unknown `mcp__*` tools default to network. */
const DYNAMIC_CLASS = new Map<string, { actionClass: ActionClass; reason: string }>();

export function registerToolClass(tool: string, actionClass: ActionClass, reason: string): void {
  DYNAMIC_CLASS.set(tool, { actionClass, reason });
}

export function classify(tool: string, args: unknown): { actionClass: ActionClass; reason: string } {
  const dynamic = DYNAMIC_CLASS.get(tool);
  if (dynamic) return dynamic;
  if (tool.startsWith('mcp__')) return { actionClass: 'network', reason: 'MCP tool (external side effects)' };
  if (tool === 'run_shell') {
    const command = String((args as { command?: unknown })?.command ?? '');
    for (const [re, reason] of DESTRUCTIVE) if (re.test(command)) return { actionClass: 'destructive', reason };
    for (const [re, reason] of NETWORK) if (re.test(command)) return { actionClass: 'network', reason };
    return { actionClass: 'exec', reason: 'sandboxed shell command' };
  }
  return { actionClass: TOOL_CLASS[tool] ?? 'exec', reason: TOOL_CLASS[tool] ? `${TOOL_CLASS[tool]} tool` : 'unknown tool treated as exec' };
}

const MATRIX: Record<PolicyProfile, Record<ActionClass, Verdict>> = {
  headless: { read: 'allow', write: 'allow', exec: 'allow', network: 'ask', destructive: 'ask' },
  interactive: { read: 'allow', write: 'allow', exec: 'ask', network: 'ask', destructive: 'ask' },
  plan: { read: 'allow', write: 'deny', exec: 'deny', network: 'deny', destructive: 'deny' },
};

export function evaluate(input: { tool: string; args: unknown; profile: PolicyProfile; preapprove?: string[]; sandboxHasNetwork?: boolean }): PolicyDecision {
  const { actionClass, reason } = classify(input.tool, input.args);
  let verdict = MATRIX[input.profile][actionClass];
  const pre = new Set(input.preapprove ?? []);
  if (verdict === 'ask' && (pre.has(actionClass) || pre.has(`tool:${input.tool}`) || pre.has('all'))) verdict = 'allow';
  if (verdict === 'ask' && input.profile === 'headless') return { verdict: 'deny', actionClass, reason: `${reason}; headless mode denies '${actionClass}' unless preapproved (--allow ${actionClass})` };
  return { verdict, actionClass, reason };
}
