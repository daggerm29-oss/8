export interface ActivityUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}
export interface ActivityTool {
  id: string;
  callId: string;
  tool: string;
  status: string;
  checkpoint: string;
  summary: string | null;
  durationMs: number | null;
}
export interface ActivityStep {
  id: string;
  index: number;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  usage: ActivityUsage;
  context: Record<string, number>;
  text: string;
  tools: ActivityTool[];
}
export interface ActivityAgent {
  id: string;
  parent: string | null;
  parentCall: string | null;
  kind: string;
  role: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  usage: ActivityUsage;
  steps: ActivityStep[];
}
export interface TaskActivity {
  task: string;
  status: string;
  emittedAt: number;
  usage: ActivityUsage;
  budget: { softUsd: number | null; hardUsd: number | null; softTokens: number | null; hardTokens: number | null } | null;
  agents: ActivityAgent[];
  leases: { id: string; holder: string; toolCall: string; globs: string[]; mode: string; state: string; expiresAt: string; heartbeat: string }[];
  checkpoints: { id: string; step: string | null; at: string; files: string[] }[];
  approvals: { id: string; tool: string; status: string }[];
}
