export * from './jsonrpc.ts';
export * from './models.ts';
export * from './sse.ts';

export const PROTOCOL_VERSION = '0.1.0';

/** Event envelope (architecture.md §23.1). */
export interface HelixEvent<T = unknown> {
  id: string;
  topic: string;
  ws: string;
  task?: string;
  agent?: string;
  step?: string;
  at: string;
  seq: number;
  causation?: string;
  data: T;
  persist: 'none' | 'log' | 'audit';
}

export type TaskStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaskSummary {
  id: string;
  workspaceId: string;
  workspacePath: string;
  title: string;
  goal: string;
  status: TaskStatus;
  provider: string;
  model: string;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  result?: string | null;
  error?: string | null;
}

export interface InitializeParams {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  token?: string;
  topics?: string[];
}
export interface InitializeResult {
  engineVersion: string;
  protocolVersion: string;
  engineId: string;
  capabilities: { sandboxProviders: string[]; providers: string[]; topics: string[] };
}

export interface TaskCreateParams {
  workspacePath: string;
  goal: string;
  title?: string;
  provider?: string;
  model?: string;
  verifyCommand?: string;
  maxSteps?: number;
  budgetUsd?: number;
  /** Approval policy profile. 'headless' resolves ask→deny unless preapproved (§5.7). */
  policyProfile?: 'headless' | 'interactive' | 'plan';
  preapprove?: string[];
  start?: boolean;
}

export interface LedgerTotals {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  providerReportedCalls: number;
  estimatedCalls: number;
}

/** Method names (§22.1). Implemented subset for M0. */
export const Methods = {
  initialize: 'initialize',
  shutdown: 'shutdown',
  ping: 'ping',
  taskCreate: 'task.create',
  taskStart: 'task.start',
  taskResume: 'task.resume',
  taskCancel: 'task.cancel',
  taskGet: 'task.get',
  taskList: 'task.list',
  taskWait: 'task.wait',
  taskTranscript: 'task.transcript',
  approvalRespond: 'agent.approve',
  ledgerQuery: 'ledger.query',
  budgetsSet: 'ledger.budgets.set',
  modelsList: 'models.list',
  providersList: 'models.providers.list',
  sandboxCheck: 'sandbox.check',
  eventsReplay: 'events.replay',
  /* M1 */
  indexUpdate: 'index.update',
  indexSearch: 'index.search',
  indexSymbols: 'index.symbols',
  indexImpact: 'index.impact',
  checkpointList: 'checkpoint.list',
  checkpointRestore: 'checkpoint.restore',
  artifactList: 'artifact.list',
  diagnosticsParse: 'diagnostics.parse',
  /* M1 — workbench (F-UI-1) */
  checkpointDiff: 'checkpoint.diff',
  approvalList: 'agent.approvals.list',
  workspaceList: 'workspace.list',
  /* M1 — MCP (F-MCP-1) */
  mcpList: 'mcp.list',
} as const;

export const Notifications = {
  event: 'event',
} as const;
