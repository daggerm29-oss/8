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
  /** Task-level role overrides (F-MDL-4): role → `provider/model` or `{ primary, fallbacks }`. */
  roles?: Record<string, string | { primary: string | { provider: string; model: string }; fallbacks?: Array<string | { provider: string; model: string }> }>;
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
  /* M1 — activity monitor (F-UI-2) */
  taskMonitor: 'task.monitor',
  taskSteps: 'task.steps',
  /* M1 — MCP (F-MCP-1) */
  mcpList: 'mcp.list',
  /* M1 — role-based models (F-MDL-4) */
  modelsRoles: 'models.roles',
  modelsUsage: 'models.usage',
  /* M1 — workbench files + terminal (F-UI-1, F-TRM-1) */
  fsTree: 'fs.tree',
  fsRead: 'fs.read',
  fsWrite: 'fs.write',
  terminalRun: 'terminal.run',
  terminalKill: 'terminal.kill',
  /* F-TRM-1 PTY: interactive shell in the workspace sandbox */
  ptyOpen: 'pty.open',
  ptyWrite: 'pty.write',
  ptyKill: 'pty.kill',
  /* F-SBX-3 egress allowlist */
  egressAllow: 'egress.allow',
  egressList: 'egress.list',
  /* F-SBX-4 credential masking */
  secretsBind: 'secrets.bind',
  secretsList: 'secrets.list',
  /* F-AUTH-1 provider keys in the OS keychain */
  vaultStatus: 'vault.status',
  vaultSetKey: 'vault.setKey',
  vaultDeleteKey: 'vault.deleteKey',
  /* F-PRV-1 dev server */
  previewStart: 'preview.start',
  previewStop: 'preview.stop',
  /* §18.6 element→source + select-and-instruct */
  previewInspect: 'preview.inspect',
  previewLocate: 'preview.locate',
  previewInstruct: 'preview.instruct',
  /* F-UI-4 verification evidence */
  artifactReverify: 'artifact.reverify',
  /* F-ORC-2 task DAG scheduler */
  dagRun: 'dag.run',
  dagStatus: 'dag.status',
  /* F-OBS-2 session replay */
  taskBundle: 'task.bundle',
  taskReplay: 'task.replay',
  /* F-GIT-1 minimal Git panel */
  gitStatus: 'git.status',
  gitDiff: 'git.diff',
  gitStageAll: 'git.stageAll',
  gitCommit: 'git.commit',
} as const;

export const Notifications = {
  event: 'event',
  /** Per-connection live output of `terminal.run` ({ runId, stream, text }); not persisted. */
  terminalOutput: 'terminal.output',
  /** Per-connection PTY output ({ ptyId, data }) and exit ({ ptyId, exitCode }); not persisted. */
  ptyOutput: 'pty.output',
  ptyExit: 'pty.exit',
} as const;
