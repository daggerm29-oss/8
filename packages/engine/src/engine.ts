import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
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
import { Vault } from './vault/vault.ts';
import { Ledger } from './models/ledger.ts';
import { ModelGateway } from './models/gateway.ts';
import { builtinTools } from './tools/builtin.ts';
import { TaskRuntime } from './agent/runtime.ts';
import { unshareAvailable } from './sandbox/sandbox.ts';
import { WorkspaceIndex } from './index/index.ts';
import { parseDiagnostics } from './diagnostics/parsers.ts';

export const ENGINE_VERSION = '0.1.0';

export interface EngineOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  adapters?: ProviderAdapter[];
  forceProcessSandbox?: boolean;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  taskRetryScale?: number;
  /** Resume interrupted tasks on open (default true). */
  recover?: boolean;
  /** Build the code index and composed context per task (default true). */
  indexing?: boolean;
}

const TOPICS = ['task.*', 'agent.*', 'tool.*', 'model.*', 'verify.*', 'approval.*', 'ledger.*', 'budget.*', 'context.*', 'artifact.*', 'checkpoint.*'];

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
  readonly runtime: TaskRuntime;
  readonly blobs: BlobStore;
  private heartbeat?: NodeJS.Timeout;
  private wss?: WebSocketServer;
  private closed = false;

  constructor(opts: EngineOptions = {}) {
    this.home = opts.home ?? helixHome();
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const env = opts.env ?? process.env;
    this.logger = new Logger({ dir: join(this.home, 'logs'), stderr: false, bindings: { engine: this.id } });
    this.db = new Db(join(this.home, 'engine.sqlite'));
    this.bus = new EventBus(this.db);
    this.tracer = new Tracer(this.db, { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null, logger: this.logger });
    this.blobs = new BlobStore(join(this.home, 'blobs'), this.db);
    this.vault = new Vault(env);
    this.ledger = new Ledger(this.db, this.bus);
    this.gateway = new ModelGateway({ adapters: opts.adapters ?? [new GeminiAdapter(), new OpenAIAdapter()], vault: this.vault, ledger: this.ledger, tracer: this.tracer, logger: this.logger, retry: opts.retry });
    this.runtime = new TaskRuntime({ db: this.db, bus: this.bus, gateway: this.gateway, ledger: this.ledger, tools: builtinTools(), tracer: this.tracer, engineId: this.id, blobs: this.blobs, logger: this.logger, forceProcessSandbox: opts.forceProcessSandbox, taskRetryScale: opts.taskRetryScale, helixHome: this.home, indexing: opts.indexing });

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
    peer.handle(Methods.approvalRespond, guard<{ approvalId: string; approved: boolean }>((p) => (this.runtime.approve(p.approvalId, p.approved), { ok: true })));
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
    peer.handle(Methods.checkpointList, guard<{ task: string }>((p) => this.runtime.checkpoints(p.task)));
    peer.handle(Methods.checkpointRestore, guard<{ task: string; checkpoint?: string }>((p) => this.runtime.restore(p.task, p.checkpoint)));
    peer.handle(Methods.artifactList, guard<{ task: string; kind?: string }>((p) => this.runtime.artifacts(p.task, p.kind)));
    peer.handle(Methods.diagnosticsParse, guard<{ command: string; output: string }>((p) => parseDiagnostics(p.command, p.output)));
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
    const token = randomToken();
    this.wss = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise<void>((r) => this.wss!.once('listening', () => r()));
    const actual = (this.wss.address() as { port: number }).port;
    this.wss.on('connection', (socket: WebSocket) => this.attach(new RpcPeer(wsTransport(socket)), { token }));
    writeFileSync(join(this.home, 'engine.json'), JSON.stringify({ engineId: this.id, pid: process.pid, port: actual, token }), { mode: 0o600 });
    return { port: actual, token };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    await this.runtime.shutdown();
    this.wss?.close();
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
