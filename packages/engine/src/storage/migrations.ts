/** Forward-only migrations (§21.1). Index i migrates schema v(i) → v(i+1). Never edit a shipped entry. */
export const MIGRATIONS: string[] = [
  /* v1: M0 foundations */ `
  CREATE TABLE workspace (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE engine_instances (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, stopped_at TEXT);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, ws TEXT NOT NULL REFERENCES workspace(id), title TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, policy_profile TEXT NOT NULL,
    preapprove_json TEXT NOT NULL DEFAULT '[]', verify_command TEXT, max_steps INTEGER NOT NULL,
    step_count INTEGER NOT NULL DEFAULT 0, verify_attempts INTEGER NOT NULL DEFAULT 0,
    owner_engine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, error TEXT
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE TABLE agents (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, model_role TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL REFERENCES tasks(id), step TEXT, role TEXT NOT NULL, parts_json TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX messages_task ON messages(task, id);
  CREATE TABLE steps (
    id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, ledger_entry TEXT, checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE INDEX steps_task ON steps(task, idx);
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, step TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL,
    status TEXT NOT NULL, summary TEXT, data_ref TEXT, result_tokens INTEGER, duration_ms INTEGER, cache_hit INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
  );
  CREATE INDEX tool_calls_task ON tool_calls(task);
  CREATE TABLE approvals (id TEXT PRIMARY KEY, task TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, action_class TEXT NOT NULL, status TEXT NOT NULL, decision_by TEXT, at TEXT NOT NULL);
  CREATE TABLE checkpoints (id TEXT PRIMARY KEY, task TEXT NOT NULL, step TEXT, files_json TEXT NOT NULL, at TEXT NOT NULL);

  CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, ws TEXT, task TEXT, agent TEXT, step TEXT, role TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, router_reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL, latency_ms INTEGER, status TEXT NOT NULL, usage_source TEXT NOT NULL,
    provider_usage_json TEXT, provider_response_id TEXT, context_breakdown_json TEXT, tool_tokens_json TEXT, error TEXT
  );
  CREATE INDEX ledger_task ON ledger_entries(task);
  CREATE TABLE budgets (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL, soft_usd REAL, hard_usd REAL, soft_tokens INTEGER, hard_tokens INTEGER,
    action_on_hard TEXT NOT NULL DEFAULT 'pause', UNIQUE(scope, scope_id)
  );
  CREATE TABLE budget_events (id TEXT PRIMARY KEY, budget TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL);

  CREATE TABLE events (id TEXT PRIMARY KEY, topic TEXT NOT NULL, ws TEXT NOT NULL, task TEXT, agent TEXT, step TEXT, at TEXT NOT NULL, seq INTEGER NOT NULL, causation TEXT, data_json TEXT NOT NULL);
  CREATE INDEX events_ws_seq ON events(ws, seq);
  CREATE TABLE event_seq (ws TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ws TEXT NOT NULL, topic TEXT NOT NULL, event_id TEXT NOT NULL, data_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);

  CREATE TABLE spans (
    span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL, kind INTEGER NOT NULL,
    start_ns TEXT NOT NULL, end_ns TEXT NOT NULL, status_code INTEGER NOT NULL, status_message TEXT, attributes_json TEXT NOT NULL, events_json TEXT NOT NULL
  );
  CREATE INDEX spans_trace ON spans(trace_id);

  CREATE TABLE blob_refs (hash TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (hash, owner_kind, owner_id));
  CREATE TABLE sandboxes (id TEXT PRIMARY KEY, provider TEXT NOT NULL, ws TEXT NOT NULL, owner_engine TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, destroyed_at TEXT, labels_json TEXT NOT NULL);
  `,
];
