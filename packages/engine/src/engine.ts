import type { CompactionOptions } from './context/compaction.ts';
import { mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  Methods, Notifications, PROTOCOL_VERSION, RpcError, RpcErrorCode, RpcPeer, streamTransport,
  type InitializeParams, type InitializeResult, type ProviderAdapter, type TaskCreateParams, type Transport,
} from '@helix/protocol';
import { GeminiAdapter } from '@helix/provider-gemini';
import { OpenAIAdapter } from '@helix/provider-openai';
import { Db } from './storage/db.ts';
import { BlobStore } from './storage/blobs.ts';
import { EventBus } from './events/bus.ts';
import { Tracer } from './obs/tracing.ts';
import { Logger, helixHome } from './util/log.ts';
import { prefixedId, randomToken } from './util/ids.ts';
import { globalRedactor } from './util/redact.ts';
import { Vault } from './vault/vault.ts';
import { detectKeychain, type Keychain } from './vault/keychain.ts';
import { Ledger } from './models/ledger.ts';
import { ModelGateway } from './models/gateway.ts';
import { ReplayAdapter, exportBundle, type SessionBundle } from './replay/bundle.ts';
import { DagScheduler, type DagRunParams } from './dag/scheduler.ts';
import { builtinTools } from './tools/builtin.ts';
import { McpManager, type McpServerConfig, type McpServerStatus } from './mcp/manager.ts';
import { TaskRuntime } from './agent/runtime.ts';
import { LocalSandbox, unshareAvailable } from './sandbox/sandbox.ts';
import { DEFAULT_EGRESS_ALLOWLIST, EgressProxy, type UpstreamOverride } from './sandbox/egress.ts';
import { DevServers } from './preview/devserver.ts';
import { PreviewBrowser } from './preview/browser.ts';
import { elementContext, mapElementToSource, parseLoc } from './preview/locate.ts';
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from './workspace/files.ts';
import { gitCommit, gitDiff, gitStageAll, gitStatus } from './workspace/git.ts';
import { WorkspaceIndex } from './index/index.ts';
import { parseDiagnostics } from './diagnostics/parsers.ts';
import { DepGate } from './policy/depgate.ts';

export const ENGINE_VERSION = '0.1.0';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const XTERM_DIR = fileURLToPath(new URL('../node_modules/@xterm/xterm/', import.meta.url));
const UI_FILES: Record<string, { name: string; type: string }> = {
  '/index.html': { name: join(UI_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { name: join(UI_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/app.css': { name: join(UI_DIR, 'app.css'), type: 'text/css; charset=utf-8' },
  '/vendor/xterm.js': { name: join(XTERM_DIR, 'lib/xterm.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/xterm.css': { name: join(XTERM_DIR, 'css/xterm.css'), type: 'text/css; charset=utf-8' },
};

export interface EngineOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  adapters?: ProviderAdapter[];
  forceProcessSandbox?: boolean;
  /** Test seam for the masking proxy (F-SBX-4): where intercepted requests really go. */
  egressUpstream?: UpstreamOverride;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  taskRetryScale?: number;
  /** Resume interrupted tasks on open (default true). */
  recover?: boolean;
  /** Build the code index and composed context per task (default true). */
  indexing?: boolean;
  /** Connect MCP servers from `$HELIX_HOME/mcp.json` (default true). */
  mcp?: boolean;
  /** Inline MCP server config (overrides mcp.json; tests). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hide MCP tools behind tool_search above this many tools (default 30 or mcp.json `toolSearchThreshold`). */
  mcpToolSearchThreshold?: number;
  /** Transcript compaction (F-CTX-2). Env overrides: `HELIX_COMPACT_TRIGGER_TOKENS`, `HELIX_COMPACT_KEEP_TURNS`, `HELIX_COMPACT=off`. */
  compaction?: CompactionOptions;
  /** OS credential store for provider keys (default: detected from `env`). */
  keychain?: Keychain;
}

function compactionFrom(env: NodeJS.ProcessEnv, opts?: CompactionOptions): CompactionOptions {
  const num = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return {
    ...opts,
    ...(env.HELIX_COMPACT === 'off' ? { enabled: false } : {}),
    ...(num(env.HELIX_COMPACT_TRIGGER_TOKENS) ? { triggerTokens: num(env.HELIX_COMPACT_TRIGGER_TOKENS) } : {}),
    ...(num(env.HELIX_COMPACT_KEEP_TURNS) ? { keepRecentTurns: num(env.HELIX_COMPACT_KEEP_TURNS) } : {}),
    ...(num(env.HELIX_COMPACT_MIN_SLICE_TOKENS) ? { minSliceTokens: num(env.HELIX_COMPACT_MIN_SLICE_TOKENS) } : {}),
  };
}

const TOPICS = ['task.*', 'agent.*', 'tool.*', 'model.*', 'verify.*', 'approval.*', 'ledger.*', 'budget.*', 'context.*', 'artifact.*', 'checkpoint.*', 'workspace.*', 'egress.*', 'preview.*', 'secret.*'];

/** Helix Engine (§6.2): composition root for storage, bus, gateway, tools, sandbox, and the task runtime. */
export class Engine {
  readonly id = prefixedId('eng');
  readonly home: string;
  readonly db: Db;
  readonly bus: EventBus;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly vault: Vault;
  readonly ledger: Ledger;
  readonly gateway: ModelGateway;
  readonly replay: ReplayAdapter;
  readonly runtime: TaskRuntime;
  /** Task DAG scheduler (F-ORC-2): nodes run as child tasks. */
  readonly dags: DagScheduler;
  readonly blobs: BlobStore;
  readonly mcp: McpManager;
  /** Allowlisting HTTP/CONNECT proxy shared by every sandbox (F-SBX-3). */
  readonly egress: EgressProxy;
  /** Managed workspace dev servers (F-PRV-1). */
  readonly devServers: DevServers;
  /** Lazily launched headless Chrome for agent browser tools (F-PRV-5). */
  readonly browser: PreviewBrowser;
  /** Where `secrets.bind` reads a value from when the caller passes only a name. */
  private readonly secretSource: NodeJS.ProcessEnv;
  /** Resolves once configured MCP servers are connected (or failed) and their tools are registered. */
  readonly mcpReady: Promise<McpServerStatus[]>;
  private heartbeat?: NodeJS.Timeout;
  private wss?: WebSocketServer;
  private http?: Server;
  private closed = false;
  private readonly terminals = new Map<string, LocalSandbox>();
  private readonly forceProcessSandbox: boolean;

  constructor(opts: EngineOptions = {}) {
    this.home = opts.home ?? helixHome();
    this.forceProcessSandbox = opts.forceProcessSandbox ?? false;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const env = opts.env ?? process.env;
    this.logger = new Logger({ dir: join(this.home, 'logs'), stderr: false, bindings: { engine: this.id } });
    this.db = new Db(join(this.home, 'engine.sqlite'));
    this.bus = new EventBus(this.db);
    this.tracer = new Tracer(this.db, { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null, logger: this.logger });
    this.blobs = new BlobStore(join(this.home, 'blobs'), this.db);
    this.vault = new Vault(env, opts.keychain ?? detectKeychain(env));
    this.ledger = new Ledger(this.db, this.bus);
    this.replay = new ReplayAdapter();
    this.gateway = new ModelGateway({ adapters: [...(opts.adapters ?? [new GeminiAdapter(), new OpenAIAdapter()]), this.replay], vault: this.vault, ledger: this.ledger, tracer: this.tracer, logger: this.logger, retry: opts.retry });
    this.egress = new EgressProxy({
      isAllowed: (host, ctx) => DEFAULT_EGRESS_ALLOWLIST.includes(host) || !!this.db.get('SELECT 1 AS ok FROM egress_allow WHERE ws = ? AND host = ?', this.runtime.workspaceFor(ctx.root).id, host),
      onDenied: (info, ctx) => {
        this.bus.publish({ topic: 'egress.denied', ws: this.runtime.workspaceFor(ctx.root).id, data: { ...info, sandbox: ctx.sandboxId }, persist: 'audit' });
        this.logger.warn('egress.denied', { ...info, sandbox: ctx.sandboxId });
      },
      onExfil: (info, ctx) => {
        this.bus.publish({ topic: 'secret.exfil_attempt', ws: this.runtime.workspaceFor(ctx.root).id, data: { ...info, sandbox: ctx.sandboxId }, persist: 'audit' });
        this.logger.warn('secret.exfil_attempt', { ...info, sandbox: ctx.sandboxId });
      },
    }, { upstream: opts.egressUpstream });
    this.secretSource = env;
    this.devServers = new DevServers({
      egress: this.egress, forceProcess: opts.forceProcessSandbox,
      onReady: (root, info) => this.bus.publish({ topic: 'preview.ready', ws: this.runtime.workspaceFor(root).id, data: { ...info, workspacePath: root } }),
      onExit: (root, info, code) => this.bus.publish({ topic: 'preview.exited', ws: this.runtime.workspaceFor(root).id, data: { ...info, workspacePath: root, exitCode: code } }),
    });
    this.browser = new PreviewBrowser({ outDir: join(this.home, 'screenshots') });
    const tools = builtinTools();
    this.mcp = new McpManager({ home: this.home, registry: tools, logger: this.logger, config: opts.mcpServers, toolSearchThreshold: opts.mcpToolSearchThreshold });
    this.mcpReady = opts.mcp === false ? Promise.resolve([]) : this.mcp.start();
    this.runtime = new TaskRuntime({ db: this.db, bus: this.bus, gateway: this.gateway, ledger: this.ledger, tools, tracer: this.tracer, engineId: this.id, blobs: this.blobs, logger: this.logger, forceProcessSandbox: opts.forceProcessSandbox, egress: this.egress, devServers: this.devServers, browser: this.browser, taskRetryScale: opts.taskRetryScale, helixHome: this.home, replay: this.replay, indexing: opts.indexing, compaction: compactionFrom(env, opts.compaction),
      depGate: env.HELIX_DEP_GATE === 'off' ? undefined : new DepGate({ osvUrl: env.HELIX_OSV_URL, npmRegistryUrl: env.HELIX_NPM_REGISTRY_URL, pypiUrl: env.HELIX_PYPI_URL }) });
    this.dags = new DagScheduler({ db: this.db, runtime: this.runtime, worktreeRoot: join(this.home, 'worktrees') });

    const now = new Date().toISOString();
    this.db.run('INSERT INTO engine_instances (id, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?)', this.id, process.pid, now, now);
    this.heartbeat = setInterval(() => this.db.run('UPDATE engine_instances SET heartbeat_at = ? WHERE id = ?', new Date().toISOString(), this.id), 5000);
    this.heartbeat.unref();
    this.reapSandboxes();
    if (opts.recover !== false) {
      const resumed = this.runtime.recover();
      if (resumed.length) this.logger.info('resumed interrupted tasks', { tasks: resumed });
    }
  }

  /** Sandbox reaper (§16.4): sandboxes owned by engines that are gone are marked destroyed. */
  private reapSandboxes(): void {
    this.db.run(`UPDATE sandboxes SET state = 'destroyed', destroyed_at = ? WHERE state != 'destroyed' AND owner_engine != ?`, new Date().toISOString(), this.id);
  }

  /** Register every JSON-RPC method (§22.1 M0 subset) on a peer. */
  attach(peer: RpcPeer, opts: { token?: string } = {}): void {
    let initialized = opts.token === undefined;
    const unsubs: Array<() => void> = [];
    const guard = <P>(fn: (p: P) => unknown) => (params: unknown) => {
      if (!initialized) throw new RpcError(RpcErrorCode.InvalidRequest, 'call initialize with a valid token first');
      return fn((params ?? {}) as P);
    };
    peer.handle(Methods.initialize, (params): InitializeResult => {
      const p = (params ?? {}) as InitializeParams;
      if (opts.token !== undefined) {
        const a = Buffer.from(p.token ?? '');
        const b = Buffer.from(opts.token);
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw new RpcError(RpcErrorCode.InvalidRequest, 'invalid token');
      }
      initialized = true;
      for (const topic of p.topics ?? []) unsubs.push(this.bus.subscribe(topic, (e) => peer.notify(Notifications.event, e)));
      return { engineVersion: ENGINE_VERSION, protocolVersion: PROTOCOL_VERSION, engineId: this.id, capabilities: { sandboxProviders: [unshareAvailable() ? 'local-unshare' : 'local-process'], providers: this.gateway.providers().map((x) => x.id), topics: TOPICS } };
    });
    peer.onClose(() => unsubs.forEach((u) => u()));
    peer.handle(Methods.ping, () => ({ pong: true, at: new Date().toISOString() }));
    peer.handle(Methods.shutdown, guard(async () => {
      setTimeout(() => void this.close(), 10);
      return { ok: true };
    }));
    peer.handle(Methods.taskCreate, guard<TaskCreateParams>((p) => this.runtime.create(p)));
    peer.handle(Methods.taskStart, guard<{ id: string }>((p) => (this.runtime.start(p.id), this.runtime.summary(p.id))));
    peer.handle(Methods.taskResume, guard<{ id: string }>((p) => (this.runtime.start(p.id), this.runtime.summary(p.id))));
    peer.handle(Methods.taskCancel, guard<{ id: string }>((p) => this.runtime.cancel(p.id)));
    peer.handle(Methods.taskGet, guard<{ id: string }>((p) => this.runtime.summary(p.id)));
    peer.handle(Methods.taskList, guard<{ limit?: number }>((p) => this.runtime.list(p.limit)));
    peer.handle(Methods.taskWait, guard<{ id: string; timeoutMs?: number }>((p) => this.runtime.wait(p.id, p.timeoutMs)));
    peer.handle(Methods.taskTranscript, guard<{ id: string }>((p) => this.runtime.transcript(p.id)));
    peer.handle(Methods.approvalRespond, guard<{ approvalId: string; approved: boolean; always?: boolean }>((p) => {
      let alwaysAllowed: { server: string; tool: string } | null = null;
      if (p.approved && p.always) {
        const tool = this.runtime.approvalTool(p.approvalId);
        alwaysAllowed = tool ? this.mcp.alwaysAllow(tool) : null;
        if (!alwaysAllowed) throw new Error(`'always allow' is only supported for MCP tools (got ${tool ?? 'unknown approval'})`);
      }
      this.runtime.approve(p.approvalId, p.approved);
      return { ok: true, alwaysAllowed };
    }));
    peer.handle(Methods.ledgerQuery, guard<{ task?: string; ws?: string; entries?: boolean }>((p) => ({ totals: this.ledger.totals(p), entries: p.entries ? this.ledger.entries({ task: p.task }) : undefined })));
    peer.handle(Methods.budgetsSet, guard<Parameters<Ledger['setBudget']>[0]>((p) => ({ id: this.ledger.setBudget(p) })));
    peer.handle(Methods.providersList, guard(() => this.gateway.providers()));
    peer.handle(Methods.modelsList, guard<{ provider: string }>((p) => this.gateway.listModels(p.provider)));
    peer.handle(Methods.sandboxCheck, guard(() => ({ unshare: unshareAvailable() })));
    peer.handle(Methods.eventsReplay, guard<{ ws: string; afterSeq?: number; limit?: number }>((p) => (this.bus.flush(), this.bus.replay(p.ws, p.afterSeq ?? 0, p.limit))));
    peer.handle(Methods.indexUpdate, guard<{ workspacePath: string }>((p) => {
      const idx = this.index(p.workspacePath);
      return { ...idx.update(), ...idx.counts(), generation: idx.generation() };
    }));
    peer.handle(Methods.indexSearch, guard<{ workspacePath: string; query: string; limit?: number }>((p) => {
      const idx = this.index(p.workspacePath);
      idx.update();
      return idx.search(p.query, { limit: p.limit });
    }));
    peer.handle(Methods.indexSymbols, guard<{ workspacePath: string; name: string }>((p) => {
      const idx = this.index(p.workspacePath);
      idx.update();
      return idx.findSymbol(p.name);
    }));
    peer.handle(Methods.indexImpact, guard<{ workspacePath: string; target: string; depth?: number }>((p) => {
      const idx = this.index(p.workspacePath);
      idx.update();
      return idx.impact(p.target, { depth: p.depth });
    }));
    peer.handle(Methods.checkpointList, guard<{ task: string }>((p) => this.runtime.checkpoints(p.task)));
    peer.handle(Methods.checkpointRestore, guard<{ task: string; checkpoint?: string }>((p) => this.runtime.restore(p.task, p.checkpoint)));
    peer.handle(Methods.artifactReverify, guard<{ id: string }>((p) => {
      if (typeof p.id !== 'string' || !p.id) throw new Error('id is required');
      return this.runtime.reverifyArtifact(p.id);
    }));
    peer.handle(Methods.artifactList, guard<{ task: string; kind?: string }>((p) => this.runtime.artifacts(p.task, p.kind)));
    peer.handle(Methods.diagnosticsParse, guard<{ command: string; output: string }>((p) => parseDiagnostics(p.command, p.output)));
    peer.handle(Methods.checkpointDiff, guard<{ task: string; checkpoint?: string }>((p) => this.runtime.diff(p.task, p.checkpoint)));
    peer.handle(Methods.approvalList, guard<{ task?: string }>((p) => this.runtime.approvalList(p.task)));
    peer.handle(Methods.workspaceList, guard(() => this.runtime.workspaces()));
    peer.handle(Methods.taskMonitor, guard<{ limit?: number }>((p) => this.runtime.monitor(Math.min(Math.max(Number(p?.limit) || 50, 1), 200))));
    peer.handle(Methods.taskSteps, guard<{ task: string }>((p) => {
      if (typeof p.task !== 'string' || !p.task) throw new Error('task is required');
      return this.runtime.steps(p.task);
    }));
    peer.handle(Methods.modelsRoles, guard<{ workspacePath?: string; task?: string; provider?: string; model?: string; roles?: TaskCreateParams['roles']; policyProfile?: string }>((p) => {
      if (p.task) return this.runtime.artifacts(p.task, 'roles').at(-1)?.data ?? null;
      return this.runtime.resolveTaskRoles(this.runtime.workspaceFor(p.workspacePath ?? process.cwd()).path, p as never);
    }));
    peer.handle(Methods.dagRun, guard<DagRunParams>((p) => this.dags.run(p)));
    peer.handle(Methods.dagStatus, guard<{ id: string }>((p) => this.dags.status(p.id)));
    peer.handle(Methods.taskBundle, guard<{ task: string }>((p) => {
      if (typeof p.task !== 'string' || !p.task) throw new Error('task is required');
      return exportBundle(this.db, p.task);
    }));
    peer.handle(Methods.taskReplay, guard<{ task?: string; bundle?: SessionBundle; workspacePath?: string }>((p) => {
      const bundle = p.bundle ?? (typeof p.task === 'string' && p.task ? exportBundle(this.db, p.task) : undefined);
      if (!bundle) throw new Error('task or bundle is required');
      return this.runtime.replay(bundle, p.workspacePath ? this.knownWorkspace(p.workspacePath) : undefined);
    }));
    peer.handle(Methods.modelsUsage, guard<{ task: string }>((p) => {
      if (typeof p.task !== 'string' || !p.task) throw new Error('task is required');
      this.bus.flush();
      const usage = this.db.all<Record<string, unknown>>(
        `SELECT role, provider, model, COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failed,
                SUM(input_tokens) AS inputTokens, SUM(cached_input_tokens) AS cachedInputTokens, SUM(output_tokens) AS outputTokens,
                SUM(COALESCE(cost_usd, 0)) AS costUsd, MIN(at) AS firstAt, MAX(at) AS lastAt
         FROM ledger_entries WHERE task = ? GROUP BY role, provider, model ORDER BY MIN(at)`, p.task);
      const fallbacks = this.db.all<{ at: string; data_json: string }>(`SELECT at, data_json FROM events WHERE task = ? AND topic = 'model.fallback' ORDER BY seq`, p.task)
        .map((e) => ({ at: e.at, ...(JSON.parse(e.data_json) as Record<string, unknown>) }));
      return { bindings: this.runtime.artifacts(p.task, 'roles').at(-1)?.data ?? null, usage, fallbacks };
    }));
    peer.handle(Methods.mcpList, guard(async () => { await this.mcpReady; return this.mcp.list(); }));
    peer.handle(Methods.fsTree, guard<{ workspacePath: string }>((p) => listWorkspaceFiles(this.knownWorkspace(p.workspacePath))));
    peer.handle(Methods.fsRead, guard<{ workspacePath: string; path: string }>((p) => readWorkspaceFile(this.knownWorkspace(p.workspacePath), p.path)));
    peer.handle(Methods.fsWrite, guard<{ workspacePath: string; path: string; content: string; baseHash: string | null }>((p) => {
      const root = this.knownWorkspace(p.workspacePath);
      const ws = this.runtime.workspaceFor(root);
      const busy = this.db.all<{ id: string }>('SELECT id FROM tasks WHERE ws = ?', ws.id).find((t) => this.runtime.isRunning(t.id));
      if (busy) throw new Error(`task ${busy.id} is running in this workspace; wait for it or cancel it before editing`);
      const r = writeWorkspaceFile(root, p.path, p.content, p.baseHash ?? null);
      this.bus.publish({ topic: 'workspace.file_written', ws: ws.id, data: { path: r.path, size: r.size, hash: r.hash, created: r.created, by: 'user' }, persist: 'audit' });
      this.logger.info('fs.write', { path: r.path, size: r.size });
      return r;
    }));
    const runs = new Map<string, AbortController>();
    peer.onClose(() => runs.forEach((c) => c.abort()));
    peer.handle(Methods.terminalRun, guard<{ workspacePath: string; command: string; cwd?: string; timeoutMs?: number; runId?: string }>(async (p) => {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new Error('command is required');
      const sbx = this.terminalSandbox(this.knownWorkspace(p.workspacePath));
      const runId = typeof p.runId === 'string' && p.runId ? p.runId.slice(0, 64) : prefixedId('run');
      const ctrl = new AbortController();
      runs.set(runId, ctrl);
      this.logger.info('terminal.run', { runId, cwd: p.cwd ?? '.', command: p.command.slice(0, 200) });
      try {
        const r = await sbx.exec(p.command, {
          cwd: p.cwd, timeoutMs: Math.min(Math.max(Number(p.timeoutMs) || 120_000, 1000), 600_000), maxOutputBytes: 1024 * 1024, signal: ctrl.signal,
          onOutput: (stream, text) => peer.notify(Notifications.terminalOutput, { runId, stream, text }),
        });
        return { runId, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated, durationMs: r.durationMs, killed: ctrl.signal.aborted, sandbox: sbx.info() };
      } finally { runs.delete(runId); }
    }));
    peer.handle(Methods.terminalKill, guard<{ runId: string }>((p) => {
      const c = runs.get(p.runId);
      c?.abort();
      return { killed: !!c };
    }));

    peer.handle(Methods.vaultStatus, guard(() => this.vault.status()));
    peer.handle(Methods.vaultSetKey, guard<{ provider: string; key: string }>((p) => {
      this.vault.setProviderKey(p.provider, p.key);
      this.bus.publish({ topic: 'vault.key_set', ws: 'engine', data: { provider: p.provider, store: this.vault.keychain.kind }, persist: 'audit' });
      return { ok: true, provider: p.provider, source: this.vault.keySource(p.provider) };
    }));
    peer.handle(Methods.vaultDeleteKey, guard<{ provider: string }>((p) => {
      this.vault.deleteProviderKey(p.provider);
      this.bus.publish({ topic: 'vault.key_deleted', ws: 'engine', data: { provider: p.provider, store: this.vault.keychain.kind }, persist: 'audit' });
      return { ok: true, provider: p.provider, source: this.vault.keySource(p.provider) };
    }));
    peer.handle(Methods.egressAllow, guard<{ workspacePath: string; host: string }>((p) => {
      const host = typeof p.host === 'string' ? p.host.trim().toLowerCase() : '';
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) throw new Error('host must be a DNS name like example.com');
      const ws = this.runtime.workspaceFor(this.knownWorkspace(p.workspacePath));
      this.db.run('INSERT OR IGNORE INTO egress_allow (ws, host, at) VALUES (?, ?, ?)', ws.id, host, new Date().toISOString());
      this.bus.publish({ topic: 'egress.allowed', ws: ws.id, data: { host, by: 'user' }, persist: 'audit' });
      return { ok: true, host };
    }));
    peer.handle(Methods.secretsBind, guard<{ workspacePath: string; name: string; injectHosts: string[]; value?: string }>((p) => {
      const root = this.knownWorkspace(p.workspacePath);
      const value = p.value ?? this.secretSource[p.name];
      if (!value) throw new Error(`no value for ${p.name}: pass value or set it in the Engine environment`);
      globalRedactor.register(value);
      const b = this.egress.bind(root, { name: p.name, value, injectHosts: Array.isArray(p.injectHosts) ? p.injectHosts : [] });
      const ws = this.runtime.workspaceFor(root);
      this.bus.publish({ topic: 'secret.bound', ws: ws.id, data: { name: b.name, injectHosts: b.injectHosts }, persist: 'audit' });
      return { name: b.name, injectHosts: b.injectHosts, sentinel: b.sentinel };
    }));
    peer.handle(Methods.secretsList, guard<{ workspacePath: string }>((p) => this.egress.bindingsFor(this.knownWorkspace(p.workspacePath)).map((b) => ({ name: b.name, injectHosts: b.injectHosts }))));
    peer.handle(Methods.egressList, guard<{ workspacePath: string }>((p) => {
      const ws = this.runtime.workspaceFor(this.knownWorkspace(p.workspacePath));
      return { defaults: DEFAULT_EGRESS_ALLOWLIST, workspace: this.db.all<{ host: string; at: string }>('SELECT host, at FROM egress_allow WHERE ws = ? ORDER BY host', ws.id) };
    }));

    peer.handle(Methods.previewStart, guard<{ workspacePath: string }>((p) => this.devServers.start(this.knownWorkspace(p.workspacePath))));
    peer.handle(Methods.previewStop, guard<{ workspacePath: string }>((p) => ({ stopped: this.devServers.stop(this.knownWorkspace(p.workspacePath)) })));
    const previewUrl = (root: string) => {
      const info = this.devServers.get(root);
      if (!info) throw new Error('no dev server running for this workspace (start it first)');
      return info.url;
    };
    const locateAt = async (workspacePath: string, x: number, y: number) => {
      const root = this.knownWorkspace(workspacePath);
      const card = await this.browser.locate(previewUrl(root), x, y);
      if (!card) throw new Error(`no element at ${x},${y}`);
      const idx = this.index(root);
      const source = mapElementToSource(card, idx);
      return { root, card, source, context: elementContext(card, source, idx) };
    };
    peer.handle(Methods.previewInspect, guard<{ workspacePath: string }>(async (p) => {
      const shot = await this.browser.screenshot(previewUrl(this.knownWorkspace(p.workspacePath)));
      return { image: readFileSync(shot.path).toString('base64'), width: 1280, height: 800, url: shot.url, title: shot.title };
    }));
    peer.handle(Methods.previewLocate, guard<{ workspacePath: string; x: number; y: number }>(async (p) => {
      const { card, source, context } = await locateAt(p.workspacePath, p.x, p.y);
      return { card, source, context };
    }));
    peer.handle(Methods.previewInstruct, guard<{ workspacePath: string; x: number; y: number; instruction: string; path?: string; start?: boolean } & Omit<TaskCreateParams, 'workspacePath' | 'goal'>>(async (p) => {
      const instruction = String(p.instruction ?? '').trim();
      if (!instruction) throw new Error('instruction is required');
      const { root, card, source, context } = await locateAt(p.workspacePath, p.x, p.y);
      let confirmed = source;
      if (p.path) {
        const at = parseLoc(root, `${p.path}:${source && source.path === p.path ? source.line : 1}`);
        if (!at) throw new Error(`not a workspace file: ${p.path}`);
        confirmed = { path: at.path, line: at.line, strategy: source?.strategy ?? 'text', confidence: 1, needsConfirm: false, chain: source?.chain ?? [] };
      }
      const ctx = confirmed !== source ? elementContext(card, confirmed, this.index(root)) : context;
      const { x: _x, y: _y, instruction: _i, path: _p, ...rest } = p;
      const task = this.runtime.create({ ...rest, workspacePath: root, goal: `${instruction}\n\n${ctx}`, title: rest.title ?? instruction.slice(0, 80), start: p.start ?? true });
      return { task, card, source: confirmed };
    }));
    peer.handle(Methods.gitStatus, guard<{ workspacePath: string }>((p) => gitStatus(this.knownWorkspace(p.workspacePath))));
    peer.handle(Methods.gitDiff, guard<{ workspacePath: string }>((p) => gitDiff(this.knownWorkspace(p.workspacePath))));
    peer.handle(Methods.gitStageAll, guard<{ workspacePath: string }>((p) => gitStageAll(this.knownWorkspace(p.workspacePath))));
    peer.handle(Methods.gitCommit, guard<{ workspacePath: string; message: string }>((p) => gitCommit(this.knownWorkspace(p.workspacePath), p.message)));

    const ptys = new Map<string, ReturnType<LocalSandbox['pty']>>();
    peer.onClose(() => { ptys.forEach((p) => p.kill()); ptys.clear(); });
    peer.handle(Methods.ptyOpen, guard<{ workspacePath: string; cols?: number; rows?: number; cwd?: string }>((p) => {
      if (ptys.size >= 4) throw new Error('too many open terminals (max 4 per connection)');
      const sbx = this.terminalSandbox(this.knownWorkspace(p.workspacePath));
      const ptyId = prefixedId('pty');
      const handle = sbx.pty({
        cols: p.cols, rows: p.rows, cwd: p.cwd,
        onData: (data) => peer.notify(Notifications.ptyOutput, { ptyId, data }),
        onExit: (exitCode) => { ptys.delete(ptyId); peer.notify(Notifications.ptyExit, { ptyId, exitCode }); this.logger.info('pty.exit', { ptyId, exitCode }); },
      });
      ptys.set(ptyId, handle);
      this.logger.info('pty.open', { ptyId, workspace: p.workspacePath });
      return { ptyId, sandbox: sbx.info() };
    }));
    peer.handle(Methods.ptyWrite, guard<{ ptyId: string; data: string }>((p) => {
      const h = ptys.get(p.ptyId);
      if (!h) throw new Error(`no such terminal: ${p.ptyId}`);
      if (typeof p.data !== 'string' || p.data.length > 64 * 1024) throw new Error('data must be a string up to 64 KiB');
      h.write(p.data);
      return { ok: true };
    }));
    peer.handle(Methods.ptyKill, guard<{ ptyId: string }>((p) => {
      const h = ptys.get(p.ptyId);
      h?.kill();
      return { killed: !!h };
    }));
  }

  /** Workbench file/terminal access is limited to workspaces the Engine already knows (created via a task or index call). */
  private knownWorkspace(path: string): string {
    if (typeof path !== 'string' || !path) throw new Error('workspacePath is required');
    let real: string;
    try { real = realpathSync(resolve(path)); } catch { throw new Error(`no such workspace: ${path}`); }
    const ws = this.runtime.workspaces().find((w) => { try { return realpathSync(w.path) === real; } catch { return false; } });
    if (!ws) throw new Error(`unknown workspace '${path}': create a task in it first`);
    return real;
  }

  /** One contained sandbox per workspace for terminal commands (F-TRM-1 v0, non-PTY). Same isolation as agent shell. */
  private terminalSandbox(root: string): LocalSandbox {
    let s = this.terminals.get(root);
    if (!s) {
      s = new LocalSandbox(prefixedId('term'), root, { forceProcess: this.forceProcessSandbox, egress: this.egress });
      this.terminals.set(root, s);
    }
    return s;
  }

  /** Index for a workspace path (registers the workspace on first use). */
  index(workspacePath: string): WorkspaceIndex {
    const ws = this.runtime.workspaceFor(workspacePath);
    return new WorkspaceIndex(this.db, ws.id, ws.path);
  }

  serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): RpcPeer {
    const peer = new RpcPeer(streamTransport(input, output));
    this.attach(peer);
    return peer;
  }

  /** Loopback WebSocket server (§22.2) with a per-start bearer token written to `$HELIX_HOME/engine.json` (0600). */
  async serveWebSocket(port = 0): Promise<{ port: number; token: string }> {
    return this.serve({ port });
  }

  /**
   * HTTP + WebSocket server on one port (§22.2, F-UI-1). `ui` serves the no-build workbench from
   * `packages/engine/ui/`. The token travels in the URL fragment (`/#token=…`), which browsers never send to
   * the server, so serving the page does not leak it. Host and Origin headers must be loopback (or listed in
   * `allowedHosts`) to defeat DNS rebinding. `noAuth` exists only for remote dev previews and is loud about it.
   */
  async serve(opts: { port?: number; host?: string; ui?: boolean; noAuth?: boolean; allowedHosts?: string[] } = {}): Promise<{ port: number; token: string; url: string }> {
    const token = randomToken();
    const host = opts.host ?? '127.0.0.1';
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', ...(opts.allowedHosts ?? [])]);
    const anyHost = opts.allowedHosts?.includes('*') ?? false;
    const hostOk = (h: string | undefined) => {
      if (!h) return false;
      if (anyHost) return true;
      const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
      return allowed.has(name);
    };
    const originOk = (o: string | undefined, h: string | undefined) => {
      if (!o) return true;
      try { return new URL(o).host === h || hostOk(new URL(o).host); } catch { return false; }
    };
    this.http = createServer((req, res) => {
      if (!hostOk(req.headers.host)) { res.writeHead(403).end('forbidden host'); return; }
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, engineId: this.id })); return; }
      if (path === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ engineVersion: ENGINE_VERSION, auth: opts.noAuth ? 'none' : 'token' }));
        return;
      }
      if (!opts.ui) { res.writeHead(404).end('not found'); return; }
      const file = UI_FILES[path === '/' ? '/index.html' : path];
      if (!file) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*; frame-ancestors *",
      }).end(readFileSync(file.name));
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.http.on('upgrade', (req, socket, head) => {
      if (!hostOk(req.headers.host) || !originOk(req.headers.origin, req.headers.host)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(new RpcPeer(wsTransport(ws)), opts.noAuth ? {} : { token }));
    });
    await new Promise<void>((r) => this.http!.listen(opts.port ?? 0, host, () => r()));
    const actual = (this.http.address() as { port: number }).port;
    writeFileSync(join(this.home, 'engine.json'), JSON.stringify({ engineId: this.id, pid: process.pid, port: actual, token }), { mode: 0o600 });
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return { port: actual, token, url: `http://${shown}:${actual}/${opts.noAuth ? '' : `#token=${token}`}` };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    await this.runtime.shutdown();
    await this.mcpReady.catch(() => []);
    await this.mcp.close();
    for (const s of this.terminals.values()) s.destroy();
    this.terminals.clear();
    await this.devServers.closeAll();
    await this.browser.close();
    this.egress.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    this.http?.closeAllConnections();
    this.http?.close();
    rmSync(join(this.home, 'engine.json'), { force: true });
    this.db.run('UPDATE engine_instances SET stopped_at = ? WHERE id = ?', new Date().toISOString(), this.id);
    this.bus.close();
    this.db.close();
  }
}

export function wsTransport(socket: WebSocket): Transport {
  return {
    send: (m) => socket.send(m),
    onMessage: (h) => socket.on('message', (d) => h(d.toString())),
    onClose: (h) => socket.on('close', (_code, reason) => h(reason.toString())),
    close: () => socket.close(),
  };
}
