export interface ActivityUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}
export interface ActivityContextItem {
  kind: string;
  label: string;
  tokens: number;
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
  contextItems: ActivityContextItem[];
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
  title: string;
  status: string;
  provider: string;
  model: string;
  availableModels: string[];
  startedAt: string;
  endedAt: string | null;
  forkedFrom: { task: string; checkpoint: string } | null;
  emittedAt: number;
  usage: ActivityUsage;
  budget: { softUsd: number | null; hardUsd: number | null; softTokens: number | null; hardTokens: number | null } | null;
  agents: ActivityAgent[];
  leases: { id: string; holder: string; toolCall: string; globs: string[]; mode: string; state: string; expiresAt: string; heartbeat: string }[];
  checkpoints: { id: string; step: string | null; at: string; files: string[] }[];
  approvals: { id: string; tool: string; status: string }[];
}
