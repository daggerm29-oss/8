# HELIX — Development Progress

> **Read this first.** This file is the single source of truth for what is actually implemented. `plan.md` is the product spec, and `architecture.md` is the technical blueprint. A status of **Verified** means an automated or manual check proved the acceptance criteria. Written code alone is at most **Implemented**.

## Project Status

- Project: Helix
- Current Phase: M1 — Core MVP (engine-side slice in progress)
- Overall Completion: ~25% (M0 Verified; **M1 = 31/76 features Tested/Verified (41%)**, 3 In Progress, 42 Not Started. Counted from the Feature Status table: Tested+Verified ÷ total — recount every session, never estimate)
- Current Status: M1 session 15 — workbench Steps tab (Agent→Step→ToolCall tree, RPC `task.steps`) Tested (browser + live Gemini)
- Last Updated: 2026-11-07 (session 15)
- Current Development Branch: `helix/m1-session15-steps` (note: `origin/helix/m1-session15` holds an earlier parallel attempt, commit d1396d6 `task.tree` — pick one PR, do not merge both) (base: `main` of github.com/daggerm29-oss/8)

## Phase Overview

| Phase | Name | Status | Completion |
|---|---|---|---|
| M0 | Engineering Foundations | Verified (exit criteria met live, 2026-11-06) | 100% |
| M1 | Core MVP | In Progress | 41% (31/76). Biggest gaps: preview + CDP + browser tools (F-PRV-1..5), egress proxy (F-SBX-3), visual/snapshot (F-VIS-*), Plan Mode/Explore subagent (F-ORC-*), review (F-REV-*), Git panel (F-GIT-1/3/4/5), desktop shell (F-UI-3/4), PTY terminal (F-TRM-1) |
| M2 | Advanced Intelligence | Not Started | 0% |
| M3 | Multi-Agent Intelligence | Not Started | 0% |
| M4 | Team and Ecosystem | Not Started | 0% |
| M5 | Platform Expansion | Not Started | 0% |
| M6 | Collaboration | Not Started | 0% |

## Current Phase Details

**Objectives (plan §12 M0):** monorepo + build, Helix Engine process (JSON-RPC over WebSocket/stdio), event bus, SQLite storage, Gemini and OpenAI API-key adapters + conformance suite, local sandbox v0 (no masking), tool framework (fs, shell, search-exact), CLI `helix -p`, ledger v0, OpenTelemetry spans.

**Exit criteria:** (1) the CLI agent fixes a seeded failing test in 3 fixture repos inside the sandbox; (2) ledger totals reconcile with provider-reported usage; (3) an Engine restart resumes a task.

- Completed tasks: progress.md initialized; architecture/plan reviewed; pnpm workspace (`packages/*`, `apps/*`); `@helix/protocol` (JSON-RPC 2.0 peer, NDJSON framing, method/event types); engine core: SQLite storage + migrations, content-addressed blob store, event bus (batched log + hash-chained audit), OTel-compatible tracer, redacting logger, ID utils. 8/8 core tests pass (re-run in session 2).
- In progress (session 2): model gateway (Gemini + OpenAI adapters, conformance suite, ledger, budgets).
- Remaining: sandbox, terminal execution, policy, tool framework, agent loop, task persistence/recovery, JSON-RPC server, CLI, fixtures, exit tests.
- Known issues: see Bugs table.
- Dependencies: Node 24 (built-in `node:sqlite`, TypeScript type stripping), pnpm 12.
- Blockers: none hard. Environment notes: no Docker/Podman/bubblewrap in the dev VM; util-linux `unshare`, `setpriv`, `prlimit`, `pivot_root` available and unprivileged user namespaces work; cgroup v2 is not delegated to the unprivileged user; no provider API keys configured (live model calls cannot be verified until `GEMINI_API_KEY` / `OPENAI_API_KEY` are provided).
- Session note: session 1 wrote the engine core but ran out of credits before recording it here. Session 2 cloned the GitHub repo, re-ran the core tests, and logged that work below.

## Feature Implementation Tracker

Statuses: Not Started / In Progress / Implemented / Tested / Verified / Blocked / Deferred.

| Feature ID | Feature | Status | Tests | Notes |
|---|---|---|---|---|
| F-MDL-1 | Provider adapter framework | Tested | conformance 12/12 (fake servers) | IR + `ProviderAdapter` in `@helix/protocol` (IMPL-ADR-006); gateway with retry/breaker/budget pre-check. Arch §7.1, §7.2, §31.3 |
| F-MDL-2 | Gemini integration | Verified | conformance 6 Gemini cases; live M0 exit eval (3/3 fixtures, gemini-3.5-flash-lite) | `streamGenerateContent` SSE, function calling, thought-signature replay, usage normalization, error mapping, live model list + overlay. Context caching not yet. 429 per-day quota → `plan_limit` (non-retryable); per-minute → `rate_limit`. Arch §7.3 |
| F-MDL-3 | OpenAI integration (API key + Sign in with ChatGPT) | In Progress | conformance 6 OpenAI cases; live test skipped (no key) | API-key mode Tested: Responses API SSE, function tools, encrypted reasoning items with `store:false`. SIWC not started (needs OpenAI approval, §7.4). Arch §7.4, §8.2 |
| F-MDL-4 | Role-based model configuration | Tested | roles.test (3); live gemini-3.5-flash-lite (session 13) | `models/roles.ts`: user `$HELIX_HOME/models.json` < workspace `.helix/models.json` < task (`roles` param / CLI `--role`, explicit `-m` = coder override); org policy `$HELIX_HOME/policy.json` `models.{allowProviders,denyProviders,allowModels,denyModels(globs),forced}` last (deny wins). Unset roles inherit coder. Bindings persisted as `roles` artifact. `runtime.callRole`: primary → fallbacks on non-cancel ProviderError, `model.fallback` audit event; invalid_request/auth/plan_limit demote the ref for the task (in memory). Coder=`coder` (Plan Mode `planner`), compaction=`summarizer`. Ledger role per entry. RPC `models.roles`, `models.usage` (session 14). Workbench: New Task role picker with live preview + task Roles tab (configured vs actually used, fallbacks) (session 14). No OS user/org distinction beyond files. Arch §7.5 |
| F-MDL-5 | Automatic model router + fallback | Not Started | — | Arch §7.6, §29.5 |
| F-AUTH-1 | Secure credential vault | In Progress | engine models.test (vault case), sandbox.test (env scrub) | v0: env-only keys (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI_API`) held in memory, redactor-registered, never forwarded to sandboxes; host path denylist incl. `~/.codex`. OS keychain pending (IMPL-ADR-010). Arch §8.1, §8.3, §25.9 |
| F-AUTH-2 | OAuth broker | Not Started | — | Arch §8.2 |
| F-AUTH-3 | Helix account and org SSO | Not Started | — | Arch §8.5 |
| F-IDX-1 | Incremental parser and symbol index | Tested | m1.test (extractor, index) | v0 heuristic extractor TS/JS/Py/Go/Rust/Java/MD (IMPL-ADR-014), SHA-256 content-hash incremental, import edges, `git ls-files` + secret-file filter. tree-sitter pending. Arch §11.1–11.3, §12.1, §12.4 |
| F-IDX-2 | Precise references (SCIP/LSP) | Not Started | — | Arch §11.4 |
| F-IDX-3 | Code graph | Tested | graph.test (2) | v0: heuristic call-site edges `idx_refs` (migration v3, enclosing-symbol caller), `impact(symbol|file, depth≤4)` → callers by depth, affected files, covering tests; scoped by import edges for ts/js/py (IMPL-ADR-016). `impact` tool (also in Plan Mode), RPC `index.impact`, CLI `helix impact`. Plan artifacts do not yet auto-attach graph evidence. Arch §11.5 |
| F-IDX-4 | Hybrid retrieval engine | Tested | m1.test (index) | FTS5 BM25 + symbol + path retrievers, deterministic query planning, RRF(k=60) with weights, overlap dedupe, `why[]`. No vectors/rerank yet. Arch §11.6 |
| F-IDX-5 | Domain extractors | Not Started | — | Arch §11.7 |
| F-IDX-6 | Semantic embeddings (local-first) | Not Started | — | Arch §12.3 |
| F-CTX-1 | Budgeted context assembler | Tested | m1.test (assembler, runtime) | Per-kind quotas with carry-over; persisted `context` artifact keeps the prompt prefix stable across restarts; `context.composed` event. Arch §13.1–13.3 |
| F-CTX-2 | Compaction | Tested | compaction.test (4); live gemini-3.5-flash-lite (session 12) | `context/compaction.ts`: trigger = est. request > `triggerTokens` (default 80% contextWindow); cut at assistant boundary keeping `keepRecentTurns` (4); summarizer role, schema §13.4; deterministic fallback; constraints verbatim; `compaction` artifact (originals kept, restart-safe); min slice + must-shrink guards. HTS eval pending. Arch §13.4 |
| F-CTX-3 | Project instructions | Tested | m1.test (instructions, runtime) | `$HELIX_HOME/HELIX.md` → root AGENTS.md/HELIX.md → nested; truncation warning. Nested files for edited paths are loaded only at compose time (touchedPaths API exists). Arch §13.5 |
| F-CTX-4 | Typed project memory | Not Started | — | Arch §13.6 |
| F-AGT-1 | Primary agent loop | Tested | agent.test (7), cli.test (2) | M0 scope: transcript-derived state machine, per-step persistence, task-level backoff on 503/429. Arch §9.1–9.3, §30.1 |
| F-AGT-2 | Plan Mode | Verified | m1.test (plan mode); live gemini-3.5-flash-lite plan task | Write tools absent from the tool list + policy deny; `submit_plan` → plan artifact with `unverifiedPaths`; CLI `--plan`, `helix plan`. No graph evidence yet (F-IDX-3). Arch §9.4 |
| F-AGT-3 | Self-correction loop | Tested | agent.test, m1.test (diagnostics retry) | Retry prompt = structured diagnostics + 40-line tail (no full logs), max 3 attempts. Minimal-diff-since-green not yet. Arch §9.5 |
| F-AGT-4 | Verification gates | Tested | agent.test, gates.test (3) | Configurable gates: `.helix/verify.json` or `--verify auto` (inferred from package.json/tsconfig/go.mod/Cargo.toml/python) or a single `--verify cmd`; required vs optional, per-gate timeout + parser, all gates each attempt, `verify.gate` events. Baseline (session 9): `"baseline": true` runs gates before the first edit; diagnostics tagged `[pre-existing]`/`[new]` (line-independent key); `allowPreexisting` gates pass when only old diagnostics remain. Arch §9.6 |
| F-AGT-5 | Skills and hooks | Not Started | — | Arch §9.7 |
| F-ORC-1 | Subagents | Not Started | — | Arch §10.1–10.2 |
| F-ORC-2 | Task DAG scheduler | Not Started | — | Arch §10.3 |
| F-ORC-3 | Write leases and worktrees | Not Started | — | Arch §10.4 |
| F-ORC-4 | Human-in-the-loop approvals | Tested | sandbox.test (policy), agent.test (approve + headless deny) | `policy/policy.ts`; approvals table + `agent.approve`; pending approvals expire on recovery. Arch §10.5, §25.4 |
| F-ORC-5 | Background and scheduled agents | Not Started | — | Arch §10.6, §30.4 |
| F-SBX-1 | Sandbox provider abstraction | Tested | sandbox.test (4) | `LocalSandbox`: `unshare` user+net ns (fallback plain process), scrubbed env, private HOME, path confinement incl. symlinks/.git. Provider interface formalized in M1. Arch §16.1–16.2 |
| F-SBX-2 | Whole-toolchain containment | Tested | sandbox.test (containment case) | `unshare -U -r -n -m -p -f` + tmpfs root + chroot: ro /usr,/etc,/opt (+ `roPaths` option) and /bin,/lib* links, minimal /dev, rw workspace at its host path, private /tmp=HOME; no /proc,/sys,/home,/root. Probe `mountNsAvailable()`; `SandboxInfo.fsIsolation`. Arch §16.3 |
| F-SBX-3 | Network egress control | Not Started | — | Arch §16.5 |
| F-SBX-4 | Credential masking | Not Started | — | Arch §16.6, §8.3, §30.5 |
| F-SBX-5 | Lifecycle and resources | Tested | sandbox.test (timeout/cap), agent.test (destroyed state) | Per-task sandbox, process-group kill on timeout/abort, output cap, reaper on engine start. No cgroups (not delegated). Arch §16.4 |
| F-PRV-1 | Dev server detection and startup | Not Started | — | Arch §17.2 |
| F-PRV-2 | Live preview panel | Not Started | — | Arch §17.1, §17.3–17.5 |
| F-PRV-3 | Runtime telemetry | Not Started | — | Arch §18.3 |
| F-PRV-4 | Environment Snapshot (X1) | Not Started | — | Arch §18.4, §29.3 |
| F-PRV-5 | Browser automation tools | Not Started | — | Arch §18.5, §30.2 |
| F-TRM-1 | Integrated terminal | In Progress | sandbox.test, workbench-fs.test; browser (session 11) | v0 (session 11): workbench Terminal tab → RPC `terminal.run` in a per-workspace contained sandbox (no network, scrubbed env), live `terminal.output` notifications, `terminal.kill`, history. Non-PTY (no interactive programs, no colors). PTY (node-pty or `script`) still pending. Arch §19.1–19.3 |
| F-TRM-2 | Diagnostic parsers | Tested | m1.test (diagnostics) | tsc, node:test (TAP/spec), pytest, unittest, eslint (stylish), go, generic + Python traceback; RPC `diagnostics.parse`. LLM fallback extraction not yet. Arch §19.4 |
| F-GIT-1 | Source control panel | Not Started | — | Arch §20.1–20.2, §5.2 |
| F-GIT-2 | Shadow checkpoints | Tested | agent.test, m1.test (restore) | Pre-images per write; `restore(task, cp?)` atomic temp+rename, deletes agent-created files, saves pre-restore content (undoable); RPC + CLI. shadow.git + 3-way merge for user edits pending. Arch §20.3 |
| F-GIT-3 | Worktree manager | Not Started | — | Arch §20.4 |
| F-GIT-4 | PR integration | Not Started | — | Arch §20.5 |
| F-GIT-5 | Git safeguards | Not Started | — | Arch §20.6 |
| F-MCP-1 | MCP client manager | Tested | mcp.test (3), mcp-http.test (3); live Gemini (sessions 6, 7) | stdio + streamable HTTP (`mcp/http.ts`: JSON or SSE responses, Mcp-Session-Id, protocol-version header, DELETE on close, server→client requests answered -32601); `mcp.list` reports transport. No resources/prompts, no OAuth for remote servers yet. Arch §14.1–14.3 |
| F-MCP-2 | Tool registry and tool search (X7) | Tested | mcp-http.test (tool search e2e); live gemini-3.5-flash-lite | Above `toolSearchThreshold` (default 30) MCP tools are deferred; `tool_search` (keyword scoring) activates matches for later turns; activation derived from transcript (restart-safe). No embedding ranking yet. Arch §14.4, §15.2 |
| F-MCP-3 | Permissions and trust tiers | Tested | mcp.test, mcp-http.test | MCP tools = `network`; trusted+readOnlyHint = `read`; per-server `allowTools`/`denyTools` globs (deny wins, filtered tools never registered); `alwaysAllow` (ask→allow, never overrides Plan Mode deny); `agent.approve {always:true}` persists to mcp.json; workbench 'Always allow' button. Arch §14.6 |
| F-MCP-4 | Result normalization, compression, caching | Tested | mcp-safety.test | Read-only (trusted+readOnlyHint) results cached by tool + stable-JSON args (`cacheTtlMs`, default 60s; errors and side-effecting tools never cached; `mcp.cacheStats`); results > `maxResultChars` (default 20000) truncated with a note, full text in `$HELIX_HOME/mcp-results/mcpres_<sha16>.txt`, paged by `mcp_read_result {id, offset, length}` (registered on first truncation, ids validated); summary keeps `error:` text; tool_result carries `dataRef`. No JSONPath projection / compression yet. Arch §15.4 |
| F-MCP-5 | Injection defense | Tested | mcp-safety.test; live gemini-3.5-flash-lite | Untrusted MCP output wrapped in `<untrusted-tool-output source="mcp:s/t">` (forged tags escaped); provenance `{source:'mcp', trust, taint, origin}` persisted on tool_result; system prompt rule; taint derived from transcript (restart-safe) → network/destructive lose class preapproval/`all`/alwaysAllow and need confirmation (headless: deny, hint `--allow tool:<name>`). Approvals only come from RPC, never from tool output. Note: untrusted MCP tools are `network`, so a second untrusted call after taint also needs confirmation. Arch §25.6 |
| F-TOK-1 | Token ledger | Verified | engine models.test: totals reconcile exactly with provider-reported usage (Gemini + OpenAI fakes) | Live: ledger tokens == sum of raw Gemini usageMetadata for all 3 exit tasks. Per-attempt rows, provider vs estimate source, cost from manifest pricing, `ledger.entry` events. Arch §29.1, §29.6 |
| F-TOK-2 | Budgets | Tested | engine models.test: hard USD/token block before the provider call; soft threshold audit event | M0 subset: task + day scopes, pre-call check. Arch §29.6 |
| F-TOK-3 | Deterministic-first policy | Not Started | — | Arch §29.2, §15.5 |
| F-TOK-4 | Prompt-cache optimizer | Not Started | — | Arch §29.4 |
| F-VIS-1 | Element→source mapping (X2) | Not Started | — | Arch §18.6 |
| F-VIS-2 | Select-and-instruct | Not Started | — | Arch §18.6 |
| F-VIS-3 | Visual regression (X10) | Not Started | — | Arch §18.7 |
| F-VIS-4 | UI consistency analysis | Not Started | — | Arch §18.7 |
| F-TST-1 | Change-based test selection | Tested | selection.test (5); live gemini-3.5-flash-lite (session 9) | `{{tests}}` in a gate command → changed test files ∪ `coveringTests(changed)` from checkpoint changeset (index refreshed first), shell-quoted; empty → `fallback` or full run; `verify.gate.selectedTests`. Import-edge heuristic only (no call-graph/transitive selection yet). Arch §11.5, §9.6 |
| F-TST-2 | Test generation | Not Started | — | Arch §9.6 |
| F-TST-3 | Browser E2E from recordings (X16) | Not Started | — | Arch §18.5 |
| F-TST-4 | Bug auto-reproduction (X11) | Not Started | — | Arch §9.5 |
| F-REV-1 | Review agent | Not Started | — | Arch §10.2 |
| F-REV-2 | Security analysis | Not Started | — | Arch §25.10 |
| F-REV-3 | Dependency risk gate (X17) | Not Started | — | Arch §16.7 |
| F-UI-1 | Workbench | Tested | ui.test (2); browser + live Gemini run (session 6) | v0 web workbench served by the Engine (`packages/engine/ui/`, no build): task create/list, live event stream, transcript, diff per checkpoint + restore, gates, approvals, impact explorer, artifacts, ledger stats, read-only Files view (`fs.tree`/`fs.read`, secrets filtered, confined) and Terminal tab (session 11). Fragment token, Host/Origin loopback check, CSP. Edit/save via `fs.write` (hash-checked, session 12). No Electron yet. Arch §5.1–5.3 |
| F-UI-2 | Agent activity monitor | Tested | ui.test (task.monitor); browser + live Gemini run (session 10) | v0: RPC `task.monitor` (active first; status, running, elapsed, ledger, current step, last tool call, pending approvals, checkpoint count + last checkpoint files); workbench Monitor view (default with no task selected): summary stats, live table, per-task Cancel/Resume, batch approve/deny of pending approvals. Session 15: task Steps tab = Step→ToolCall tree via RPC `task.steps` (per-step model/tokens/cost/duration, assistant text, calls with status/duration/summary/args). Not yet: pause, fork, change model, held leases (no multi-agent yet). Arch §5.4 |
| F-UI-3 | Intelligence Explorer | Not Started | — | Arch §5.5 |
| F-UI-4 | Artifacts | Not Started | — | Arch §5.6 |
| F-OBS-1 | Traces and logs | Tested | core.test | Spans for model.call and tool.call; JSON-lines logs in $HELIX_HOME/logs. Arch §26.1–26.3 |
| F-OBS-2 | Session replay (X14) | Not Started | — | Arch §26.4 |
| F-OBS-3 | Audit log | Tested | core.test, agent.test (chain verify) | Terminal status, denials, approvals, verify results, resumes are audit events. Arch §26.5 |
| F-DEP-1 | Deploy adapters | Not Started | — | Arch §22.6 |
| F-TEAM-1 | Org policies | Not Started | — | Arch §25.8 |
| F-TEAM-2 | Shared memory and skills (X18) | Not Started | — | Arch §13.6 |
| F-TEAM-3 | Cloud workspaces | Not Started | — | Arch §28.4, §6.3 |

## Completed Work Log

- **2026-11-06 — Docs phase (pre-M0).** `plan.md` and `architecture.md` completed and cross-checked. The docs-phase log moved to `docs/progress-docs-phase.md`.
- **2026-11-06 — M0, session 1 (recorded in session 2). Engine core.** Feature IDs: F-OBS-1, F-OBS-3 (subset), foundations for all M0 features.
  - Implemented: `packages/protocol/src/{index,jsonrpc}.ts` (JSON-RPC 2.0 peer with request/notify/timeouts, NDJSON `LineDecoder`, stdio `streamTransport`, event envelope §23.1, M0 method names §22.1); `packages/engine/src/storage/{db,migrations,blobs}.ts` (WAL SQLite, forward-only migrations with pre-migration backup, schema v1 for tasks/steps/messages/tool_calls/approvals/checkpoints/ledger/budgets/events/audit/spans/sandboxes; zstd blob store with integrity check); `events/bus.ts` (topic patterns, per-workspace monotonic seq, 50 ms/256 batching, sync hash-chained audit log, replay); `obs/tracing.ts` (W3C ids, parent/child via AsyncLocalStorage, SQLite span store, optional OTLP/HTTP JSON export); `util/{ids,log,redact}.ts`.
  - Tests: `packages/engine/test/core.test.ts` — 8 passed, 0 failed (session 2 re-run).
- **2026-11-06 — M0, session 2. Model gateway.** Feature IDs: F-MDL-1, F-MDL-2, F-MDL-3 (API key), F-AUTH-1 (v0), F-TOK-1, F-TOK-2.
  - Implemented: `packages/protocol/src/models.ts` (message IR, `ProviderAdapter`, `ModelManifest`, normalized `Usage`, `ProviderError` kinds, estimator), `packages/protocol/src/sse.ts` (incremental SSE parser); `packages/providers/gemini` (adapter + manifest overlay with 2026-11-06 pricing); `packages/providers/openai` (Responses API adapter + overlay); `packages/providers/conformance` (TEST-ONLY protocol-faithful fake Gemini/OpenAI servers that enforce auth, call/response pairing, and thought-signature echo; conformance suite incl. gated live tests); `packages/engine/src/vault/vault.ts`, `models/ledger.ts`, `models/gateway.ts`.
  - Tests: conformance 12 passed, 2 skipped (live, no keys); engine 15 passed (8 core + 7 gateway/ledger/vault); `tsc -p tsconfig.helix.json` clean.
  - Decisions: IMPL-ADR-006, IMPL-ADR-010, IMPL-ADR-011. Usage normalization: `inputTokens` includes cached tokens; `outputTokens` includes reasoning/thought tokens (both providers bill them as output), so Gemini `candidatesTokenCount + thoughtsTokenCount` maps to `outputTokens`.

- **2026-11-06 — M0, session 3. Runtime, server, CLI, exit tests.** Feature IDs: F-SBX-1, F-SBX-5, F-ORC-4, F-AGT-1/3/4, F-MCP-2 (registry), F-GIT-2 (pre-write checkpoints), F-TRM-1 (non-PTY exec), F-OBS-1/3.
  - Implemented: `packages/engine/src/sandbox/sandbox.ts` (LocalSandbox: `unshare --user --map-root-user --net`, scrubbed env, private HOME/TMPDIR, process-group kill on timeout/abort, output cap, symlink-safe path confinement, host denylist, no `.git` writes); `policy/policy.ts` (action classes read/write/exec/network/destructive; profiles headless/interactive/plan; headless ask→deny unless `--allow <class>`); `tools/{registry,builtin}.ts` (validation, truncation, read_file/list_dir/search(rg fixed-string)/write_file/edit_file/run_shell); `agent/runtime.ts` (TaskRuntime: transcript-derived state machine, per-step persistence, verify gate with 3 attempts and diagnostic feedback, approvals, task-level backoff 5/15/30/60 s on retryable provider errors, crash recovery via `recover()` using engine heartbeat + pid liveness); `engine.ts` (composition root, all M0 JSON-RPC methods, stdio + token-authenticated loopback WebSocket, sandbox reaper, heartbeat); `main.ts` (`helix-engine --stdio|--ws [port]`); `apps/cli` (`helix -p`, `tasks`, `resume`, `ledger`; spawns a private stdio engine); `fixtures/m0/{js-calc,py-strings,ts-inventory}`; `evals/m0-exit.ts` (live exit eval).
  - Tests: engine 29/29 (8 core + 8 gateway + 6 sandbox/policy/tools + 7 agent), conformance 12/12 (+2 live skipped offline), CLI 2/2, tsc clean. Live: `evals/results/m0-exit-gemini-2026-11-06*.json` — 3/3 fixtures done, verify passed on first attempt, ledger reconciled exactly.

- **2026-11-06 — M1, session 4. Grounding + planning slice.** Feature IDs: F-TRM-2, F-CTX-3, F-IDX-1, F-IDX-4, F-CTX-1, F-GIT-2, F-AGT-2, F-AGT-3.
  - Implemented: `engine/src/diagnostics/parsers.ts`; `context/{instructions,assembler}.ts`; `index/{extract,index}.ts`; `tools/index-tools.ts` (find_symbol, code_search) + `submit_plan` in `tools/builtin.ts`; migration v2 (idx_files, idx_symbols, idx_imports, FTS5 idx_chunks, idx_generation, artifacts, checkpoint_restores); runtime: composed context in system prompt, plan-mode tool filtering + nudges, diagnostics-based retry, `checkpoints()`/`restore()`/`artifacts()`; protocol methods `index.update|search|symbols`, `checkpoint.list|restore`, `artifact.list`, `diagnostics.parse`; CLI `--plan`, `plan`, `checkpoints`, `restore`, `search`, `symbols`.
  - Tests: m1.test 8/8; engine 37/37; CLI 2/2; conformance 12/12 (+2 live skipped); tsc clean.
  - Live (gemini-3.5-flash-lite, `GEMINI_API`): ts-inventory fixed, verify passed first attempt; Plan Mode task produced a 3-step plan artifact citing src/calc.js and test/calc.test.js, 7 calls, 13253 in / 492 out tokens, no files modified.
  - Bug found and fixed by the tests: brace-less one-liners (`const f = (...) => ...;`) swallowed following lines in the extractor; Go receiver methods were dropped.

## Bugs and Known Issues

| Issue ID | Description | Severity | Affected components | Root cause | Status | Resolution |
|---|---|---|---|---|---|---|
| BUG-001 | Fixture verify `node --test test/` fails on Node 24 even when tests pass (directory treated as a file pattern) | Medium | fixtures, tests | Node ≥21 test-runner arg semantics | Fixed | Use explicit globs `node --test "test/*.test.js"` |
| BUG-002 | Gemini free-tier *daily* quota 429 was retried as a short rate limit (would back off for minutes against a 17 h reset) | Medium | provider-gemini | All 429s mapped to `rate_limit` | Fixed | per-day quota or retryDelay > 10 min → `plan_limit` (non-retryable); per-minute stays `rate_limit`; regression test in models.test |
| ISSUE-003 | Live Gemini free tier on this key: ~15 req/min and ~20 req/day per model; gemini-3.8-flash / 3.7-flash often 503 "high demand" | Info | live evals | Provider limits | Open | Use `--model gemini-3.5-flash-lite` or `--models a,b,c` (one model per fixture); task-level backoff absorbs 503s |
| ISSUE-004 | Shell commands in the sandbox could *read* host paths the user can read | Medium | sandbox | No mount namespace | Fixed (session 5) | F-SBX-2 contained root; regression test in sandbox.test. Falls back to old behaviour (fsIsolation:false) only where mount namespaces are unavailable |
| ISSUE-008 | No /proc inside the contained sandbox (tools that read /proc/self, e.g. some `ps`/process-substitution uses, fail) | Low | sandbox | Mounting a fresh procfs is denied in this VM; binding host /proc would leak same-uid /proc/<pid>/environ (incl. Engine keys) | Open | Mount a fresh procfs when permitted (pid ns is already created); never bind the host /proc |
| ISSUE-006 | CLI misses `context.composed` for a new task: the event fires before the CLI learns the task id and installs its filter | Low | CLI | Race between task.create response and the first events | Fixed (session 8) | `eventFollower` installed right after connect buffers events until `follow(id)`; also `helix ... | head` no longer crashes with EPIPE |
| ISSUE-007 | Index tools call `index.update()` (hash every file) on each invocation — fine for small repos, slow on 50k-file repos | Low | index | No file watcher yet | Open | Watcher + dirty set (§11.1) in the desktop/engine M1 indexer |
| ISSUE-005 | No cgroup limits (CPU/memory/pids) — cgroup v2 not delegated in dev VM | Low | sandbox | Environment | Open | M1: systemd-run --user --scope or delegated cgroup when available |

## Architecture Decision Log

(Deviations from or additions to `architecture.md`. Numbered `IMPL-ADR-n` to avoid clashing with architecture ADR-001…023.)

| ID | Decision | Reason | Alternatives considered | Consequences | Affected |
|---|---|---|---|---|---|
| IMPL-ADR-001 | TypeScript runs through Node 24 native type stripping; packages export `src/*.ts`; no build step in M0 (`erasableSyntaxOnly`) | Zero toolchain overhead; fast iteration | tsc/esbuild build per package | No enums/namespaces/parameter properties; desktop (M1) will need a bundler | all packages |
| IMPL-ADR-002 | Built-in `node:sqlite` instead of a native SQLite addon | No native compile step; synchronous API gives the single-writer rule of §21.1 for free | better-sqlite3 | Experimental API warning (suppressed in scripts) | storage |
| IMPL-ADR-003 | M0 uses one engine DB (`$HELIX_HOME/engine.sqlite`) with a `ws` column instead of per-workspace `meta.sqlite` + `global.sqlite` (§21.1–21.2) | No index tables exist yet; one file simplifies recovery | Split now | Split planned for M1 when the indexer lands; migrations are forward-only so the split is a new migration + copy | storage, api |
| IMPL-ADR-004 | SHA-256 for blob addresses and the audit hash chain instead of BLAKE3 (§21.3, §26.5) | BLAKE3 needs the Rust `helix-diff` addon, which is not built yet | JS BLAKE3 port | Hash function switch later needs a chain re-anchor record | storage, events |
| IMPL-ADR-005 | Native OTel-compatible tracer (OTLP/HTTP JSON export) instead of the OpenTelemetry SDK | Same data model and wire format without ~40 transitive deps | `@opentelemetry/sdk-node` | Must track OTLP JSON changes manually | obs |
| IMPL-ADR-006 | Message IR and the `ProviderAdapter` contract live in `@helix/protocol`; adapters are separate packages under `packages/providers/*` (§32). `tool_result.content` is a string in M0 instead of `Part[]` (§7.1) | Avoids an engine↔provider dependency cycle; transcripts are also API payloads (`task.transcript`). Image tool results are not needed until M1 | Contract inside `engine/models` | Protocol package grows beyond JSON-RPC types; `content: Part[]` is a compatible widening later | protocol, providers, engine |
| IMPL-ADR-010 | Vault v0 reads provider keys only from the Engine's environment, holds them in memory, and registers them with the redactor. No on-disk secret store yet | The dev VM has no OS keychain; an encrypted file with a co-located key would be security theater | Encrypted file; libsecret | Users set `GEMINI_API_KEY` / `OPENAI_API_KEY`. OS keychain (macOS Keychain, libsecret, Windows Credential Manager) arrives with the desktop app (M1) | vault |
| IMPL-ADR-012 | Task state is derived from the persisted transcript (pending tool calls → run tools; last=assistant → verify; else → model turn); each tool result is its own `tool` message, merged per turn when building requests | Exact crash recovery with no separate state machine table: completed tool calls are never repeated and finished model turns are never re-billed | Explicit step-state table; transactional assistant+results write | An interrupted *in-flight* tool call is re-run on resume (tools must be idempotent or checkpointed) | agent runtime |
| IMPL-ADR-013 | Headless profile allows workspace writes and sandboxed exec; network and destructive classes resolve ask→deny unless `--allow` | `helix -p` must be able to fix code unattended while never pushing/publishing/fetching implicitly | Ask for every write | Matches §5.7; interactive profile asks for exec | policy, CLI |
| IMPL-ADR-014 | Index v0 uses a line-oriented heuristic extractor + SQLite FTS5 (in engine.sqlite) instead of tree-sitter + Tantivy + trigram (§11.1, §12.1) | Zero native deps on Node 24 type-stripping; FTS5 ships with node:sqlite; same symbol model (§11.3) so tree-sitter swaps in behind `extract()` | web-tree-sitter WASM now | Less precise ranges for unusual syntax; no call-site edges yet. Edges table + SCIP/LSP in F-IDX-2/3 |
| IMPL-ADR-015 | The composed context is built once per task and persisted as a `context` artifact; per-turn retrieval happens through the find_symbol/code_search tools | Byte-stable prompt prefix (prompt caching, §13.2 step 5) and exact replay after restart | Re-assemble every turn | Context does not refresh automatically after large edits; compaction (F-CTX-2) will add a session block |
| IMPL-ADR-016 | Code graph v0 = name-based call-site edges (`idx_refs`) narrowed by import edges, not SCIP/LSP (§11.4–11.5) | Fast, zero-dep, good enough for impact hints and test selection; same query API will sit on precise edges later | Wait for tree-sitter/SCIP | Over-reports on common names in go/rust/java (no import scoping); reports `precision: 'heuristic'` | index |
| IMPL-ADR-017 | Sandbox containment by `unshare` mount ns + tmpfs root + chroot (no pivot_root, no /proc) instead of bubblewrap/containers (§16.3) | bwrap/Docker unavailable in the dev VM; util-linux is universal on Linux | bubblewrap; OCI runtime | Linux-only; macOS/Windows providers still needed (Seatbelt / AppContainer) | sandbox |
| IMPL-ADR-018 | Workbench v0 is a no-build HTML/ES-module UI served by the Engine on the WS port; token in URL fragment; Host/Origin allowlist | Ships the UI now without React/bundler toolchain (IMPL-ADR-001); same JSON-RPC surface the Electron shell will use | Next.js app; Electron first | Plain DOM code; migrate to the desktop React app when the shell lands. `--no-auth` exists only for remote dev previews | engine, ui |
| IMPL-ADR-011 | Provider tests use protocol-faithful fake HTTP servers (`@helix/provider-conformance`) instead of mocked adapters; live tests run automatically when keys exist | Exercises the real adapter code, SSE parsing, and usage reconciliation offline and deterministically | Mock `fetch`; recorded cassettes | Fake servers must track provider API changes; they verify plumbing, never model quality | providers, engine tests |

## Test and Verification Results

| Suite | Scope | Result | Evidence |
|---|---|---|---|
| engine core unit | JSON-RPC, NDJSON framing, migrations, blobs, event bus, audit chain, tracer, redactor, ids | Test passed (8/8) | `pnpm --filter @helix/engine test`, session 2 |
| provider conformance | Gemini + OpenAI: streaming, tool round trip, provider state replay, error normalization, abort, model list merge, cross-provider portability | Test passed (12/12) | `pnpm --filter @helix/provider-conformance test` |
| provider live | Real Gemini call with tool use | Verified via M0 live eval (Gemini); OpenAI not tested (no key) | `evals/results/` |
| sandbox/policy/tools | env scrub, no network egress, timeout group kill, output cap, path confinement, policy matrix, builtin tools | Test passed (6/6) | `packages/engine/test/sandbox.test.ts` |
| agent runtime | 3 fixtures fixed (fake model), ledger reconcile per task, verify retry, headless deny, interactive approval + 503 backoff, SIGKILL recovery | Test passed (7/7) | `packages/engine/test/agent.test.ts` |
| CLI | `helix -p` end to end over spawned stdio engine; usage | Test passed (2/2) | `apps/cli/test/cli.test.ts` |
| **M0 exit (live)** | (1) 3 fixtures fixed in sandbox by gemini-3.5-flash-lite; (2) ledger == provider-reported usage; (3) restart resume (SIGKILL test) | **Verified** | js-calc 7 steps/9573 in/204 out; py-strings 8/11811/265; ts-inventory 7/10021/235; all reconciled |
| gateway + ledger | Ledger reconciliation vs provider-reported usage, retries, breaker, budgets, vault | Test passed (7/7) | `packages/engine/test/models.test.ts` |
| typecheck | all Helix packages | Test passed | `tsc -p tsconfig.helix.json` |
| M1 engine slice | diagnostics, extractor, index, instructions+assembler, runtime context+restore, plan mode, diagnostics retry | Test passed (8/8) | `packages/engine/test/m1.test.ts`, session 4 |
| sandbox containment | host files invisible, /usr read-only, workspace rw, toolchain usable | Test passed | `sandbox.test.ts` (7/7), session 5 |
| verification gates | precedence, inference, validation, multi-gate runtime, optional gates, invalid config | Test passed (3/3) | `gates.test.ts`, session 5 |
| code graph | refs extraction, transitive impact, import scoping, file impact, tool output | Test passed (2/2) | `graph.test.ts`, session 5 |
| mcp | sanitizeSchema/exposedName; manager connect + 2-page tools/list, call, isError, timeout, broken/disabled servers, trust classes, no env leak; engine headless deny vs `tool:` preapprove | Test passed (3/3) | `mcp.test.ts`, session 6 |
| test selection + baseline | expand/quote/fallback, diagnosticKey, config; selection skips unrelated failing test; fallback on empty selection; baseline pre-existing tagging + allowPreexisting; new diagnostics block | Test passed (5/5) | `selection.test.ts`, session 9 |
| mcp safety | wrapUntrusted escaping, stableJson, taint verdicts; read-only cache, truncation + mcp_read_result paging, provenance; engine taint e2e | Test passed (3/3) | `mcp-safety.test.ts`, session 8 |
| mcp http + tool search | globMatch/toolPermitted/searchTools/activatedTools; streamable HTTP (session id, SSE with interleaved notification + server request, auth header, DELETE), deny filter, alwaysAllow persist + Plan Mode still denies; tool_search hides then activates tools | Test passed (3/3) | `mcp-http.test.ts`, session 7 |
| workbench | unifiedDiff cases; UI served without token, foreign Host/Origin 403, token-gated WS, events over socket, checkpoint.diff whole/partial/after-restore, workspace/approval list | Test passed (2/2) | `ui.test.ts`, session 6 |
| workbench files + terminal | fs.tree/fs.read filters + confinement, terminal.run streaming/exit/kill, unknown workspace rejected, UTF-8 not truncated | Test passed (2/2) | `workbench-fs.test.ts`, session 11 |
| M1 live | ts-inventory fix + Plan Mode on js-calc with gemini-3.5-flash-lite | Verified | session 4 CLI runs (see Completed Work Log) |

## Session 4 (M1 start) — live plan

Branch: `helix/m1-core` on github.com/daggerm29-oss/8 (repo moved from /7). Baseline re-verified: engine 29/29, CLI 2/2, tsc clean. `GEMINI_API` is set in project env.
Order (tick when done; next session resumes at the first unticked item):
- [x] S4-1 F-TRM-2 diagnostic parsers (`packages/engine/src/diagnostics/parsers.ts`): tsc, node:test/TAP, pytest+unittest, eslint, go, generic path:line:col + Python traceback → `Diagnostic[]`; verify retry prompt now = structured diagnostics + 40-line tail (§9.5); `verify.result` event carries diagnostics.
- [x] S4-2 F-CTX-3 project instructions (`context/instructions.ts`): `$HELIX_HOME/HELIX.md` → root `AGENTS.md`/`HELIX.md` → nested; 12k-char budget with truncation warning.
- [x] S4-3 F-IDX-1/F-IDX-4 v0 (`index/extract.ts`, `index/index.ts`, migration v2): heuristic extractor (TS/JS/Py/Go/Rust/Java/MD), FTS5 BM25 chunks (symbol-aligned + 60-line windows, camelCase term splitting), SHA-256 incremental reindex, import edges + covering tests, RRF(k=60) over bm25/symbol/path; tools `find_symbol`, `code_search`; RPC `index.update|search|symbols`; CLI `helix search|symbols`.
- [x] S4-4 F-CTX-1 v0 (`context/assembler.ts`): quotas instructions 30% / repo map 25% / slices 45% with carry-over, default 6000 tokens, persisted as `context` artifact (stable prefix across restarts), `context.composed` event.
- [x] S4-5 F-GIT-2 checkpoint list/restore (`runtime.checkpoints/restore`, atomic temp+rename, pre-restore content saved in `checkpoint_restores` so restore is undoable; RPC `checkpoint.list|restore`; CLI `helix checkpoints|restore`).
- [x] S4-6 F-AGT-2 Plan Mode: `plan` profile exposes only read tools + `submit_plan`; plan artifact (§9.4 schema + `unverifiedPaths`), up to 2 nudges if not submitted; CLI `--plan` and `helix plan <task>`.
- [x] S4-7a Offline tests: `packages/engine/test/m1.test.ts` 8/8; engine total 37/37; CLI 2/2; conformance 12/12 (+2 live skipped); tsc clean.
- [x] S4-7b Live Gemini check (ts-inventory fix + Plan Mode) passed; committed + pushed to `helix/m1-core`.
- [ ] S4-8 (deferred to session 5) F-SBX-2 mount-namespace containment (ISSUE-004).

## Session 5 (M1) — live plan

Branch: `helix/m1-session5` from `main` (session 4 work was merged to main by the user; `helix/m1-core` no longer on origin).
Order (tick when done; next session resumes at the first unticked item):
- [x] S5-1 (DONE, sandbox.test 7/7 incl. new containment test) F-SBX-2 mount-namespace containment (closes ISSUE-004): `unshare --user --map-root-user --net --mount --pid --fork`, tmpfs new root, read-only binds of /usr,/etc,/opt + symlinked /bin,/lib,/lib64,/sbin, minimal /dev nodes, rw workspace at its host path, private /tmp=HOME, no /proc /sys /home /root /vercel; chroot. Probe `mountNsAvailable()`; falls back to net-only namespace with `fsIsolation:false`.
- [x] S5-2 (DONE, gates.test 3/3) F-AGT-4 verification gates: `.helix/verify.json` (typecheck/lint/test/build/custom gates, `required`, `parser`, `timeoutMs`); precedence explicit `--verify cmd` > config > inferred (only with `--verify auto`: package.json scripts, tsc, go.mod, Cargo.toml, pytest/unittest); all gates run each attempt, retry prompt only includes failing *required* gates; `verify.gate` events + `verify.result.gates[]`; invalid config fails the task clearly. Code: `engine/src/verify/gates.ts`, `agent/runtime.ts#verify`.
- [x] S5-3 (DONE, graph.test 2/2) F-IDX-3 code graph v0: call-site edges + `impact(symbol|file)`; `impact` tool + RPC + CLI.
- [x] S5-4 (DONE) engine 43/43, CLI 2/2, conformance 12/12 (+2 live skipped), tsc clean. Live: gemini-3.5-flash-lite fixed js-calc inside the fs-contained sandbox with `--verify auto` (inferred gate `npm test --silent` passed first attempt; 8 calls, 15981 in / 287 out tokens). Pushed to `helix/m1-session5`.
- Next session starts at **Next Actions** item 1 (F-UI-1 workbench).

## Session 6 (M1) — live plan

Branch: `helix/m1-session6` from `main` (session 5 merged by the user as PR #2).
Order (tick when done; next session resumes at the first unticked item):
- [x] S6-1..S6-3 DONE (engine 45/45 incl. ui.test 2/2, CLI 2/2, tsc clean; live gemini-3.5-flash-lite task started from the workbench fixed js-calc: 6 calls, 10874 in / 190 out, gate `npm test --silent` passed attempt 1; diff/gates/impact panels verified in browser). Browser check found + fixed: diff emitted `+` before `-` (LCS backtrack order), form handler used `ev.currentTarget` after await, `[hidden]` overridden by display:flex.
- S6-1 F-UI-1 workbench v0 (as built): the Engine serves a no-build web UI (`packages/engine/ui/{index.html,app.js,app.css}`) over HTTP on the same port as the WS JSON-RPC (`serveWebSocket` → `serve({ui:true})`). Token in the URL fragment (`/#token=…`, never sent to the server); Host/Origin loopback check against DNS rebinding; `--host`/`--no-auth` dev flags for remote previews only. Panels: task list + create (workspace, goal, model, verify, plan mode), live event stream, transcript, gate results, diff per checkpoint + restore, approvals, impact explorer, ledger.
- S6-2 RPC additions: `checkpoint.diff` (`runtime.diff`, `util/diff.ts` LCS unified diff, whole-file fallback above 4M cells), `agent.approvals.list`, `workspace.list`.
- S6-3 Tests (`ui.test.ts`: HTTP serving, Host/Origin rejection, token-gated WS, checkpoint.diff) + browser check of the workbench; push.
- [x] S6-4 F-MCP-1 stdio MCP client DONE: `src/mcp/client.ts` (newline JSON-RPC, initialize/initialized, paginated tools/list, tools/call, per-request timeout + notifications/cancelled, abort, minimal env allowlist so provider keys never reach MCP servers, server→client requests answered -32601), `src/mcp/manager.ts` (`$HELIX_HOME/mcp.json` `servers`|`mcpServers`, tools exposed as `mcp__<server>__<tool>` ≤64 chars, schema sanitized to the provider-safe subset, per-server failure isolation, `enabled:false`). Policy (F-MCP-3 v0): MCP tools are `network` (ask; headless deny unless `--allow network`/`tool:<name>`), except `trusted` server + `readOnlyHint` → `read`. RPC `mcp.list`; workbench sidebar shows servers/tools. `mcp.test.ts` 3/3; live: gemini-3.5-flash-lite called `mcp__demo__echo` from the workbench (2 calls, allowed as trusted read).
  - Sandbox note: `~/.helix/mcp.json` in the v0 VM points at `test/fixtures/fake-mcp-server.mjs` as server `demo` (dev only, not in repo).

## Session 7 (M1) — live plan

Branch: `helix/m1-session7` from `main` (session 6 merged by the user as PR #4).
Order (tick when done; next session resumes at the first unticked item):
- STATUS: DONE (see S7-5).
- [x] S7-1 F-MCP-1 part 2: streamable HTTP transport (`src/mcp/http.ts`, `McpHttpClient`): POST JSON-RPC with `Accept: application/json, text/event-stream`, JSON or SSE responses, `Mcp-Session-Id` + `MCP-Protocol-Version` headers, DELETE on close, per-request timeout/abort. Config `{ "url": "...", "headers": {...} }` instead of `command`.
- [x] S7-2 F-MCP-3: per-server `allowTools` / `denyTools` (exact names or `*` globs; denied tools are never registered) and `alwaysAllow` (tools auto-approved). RPC `agent.approve` gains `always: true` → persists the tool into `alwaysAllow` in mcp.json; workbench approval card gets an "Always allow" button.
- [x] S7-3 F-MCP-2 tool search: when MCP tools > `toolSearchThreshold` (default 30), MCP tools are hidden from the model and a `tool_search` tool returns matches and activates them for the task.
- [x] S7-4 CLI `helix mcp list` / `helix mcp add <name> -- <cmd...>` / `helix mcp add <name> --url <url>`.
- [x] S7-5 `test/mcp-http.test.ts` 3/3 (glob/filters/search units; HTTP fake server with session + SSE + server request + DELETE; engine tool-search e2e with fake Gemini); engine 51/51, CLI 2/2, tsc clean. CLI smoke: `helix mcp add/list/remove`. Live gemini-3.5-flash-lite with `toolSearchThreshold: 1`: tool_search → mcp__demo__echo → 'echo: hello session7' (4 calls, 5020 in / 101 out). Pushed to `helix/m1-session7`.

## Session 8 (M1) — live plan

Branch: `helix/m1-session8` from `helix/m1-session7` (session 7 not yet merged when this started; PR it first).
- STATUS: DONE (see S8-3).
- [x] S8-1 F-MCP-4: TTL cache for read-only MCP calls (key = tool + stable args JSON; `cacheTtlMs`, default 60s; errors never cached); results > `maxResultChars` (default 20000) truncated, full text stored in `$HELIX_HOME/mcp-results/<id>.txt`, readable via `mcp_read_result {id, offset}`; error summaries keep the error text.
- [x] S8-2 F-MCP-5: untrusted MCP output wrapped in `<untrusted-tool-output source=...>` (closing tag escaped), provenance `{source:'mcp:s/t', trust, taint}` stored on the tool_result; system prompt rule; taint derived from transcript → network/destructive actions that would be auto-allowed (class preapproval / alwaysAllow) become `ask` (headless: deny) unless explicitly `--allow tool:<name>`.
- [x] S8-3 `test/mcp-safety.test.ts` 3/3 (wrap/escape, stableJson, taint matrix; cache hits/misses, no caching of record/errors, truncation + paging + id validation, provenance; engine e2e: untrusted read then preapproved `network` record denied, marker untouched, prompt rule + wrapped content sent to the model); engine 54/54, CLI 2/2, tsc clean. Live gemini-3.5-flash-lite with `--allow network`: echo ok, record denied by taint, marker untouched. Also fixed ISSUE-006 + CLI EPIPE (verified live: `context.composed` line now printed).

## Session 9 (M1) — live plan

Branch: `helix/m1-session9` from `main` (session 8 merged as PR #5).
Order (tick when done; next session resumes at the first unticked item):
- [x] S9-1 (DONE, code written; selection.test 5/5) F-TST-1 change-based test selection: gate command may contain `{{tests}}`; filled with shell-quoted test files = changed test files ∪ `index.coveringTests(changed file)` for the task's changeset (paths from `checkpoints`); empty selection → gate `fallback` command, else `{{tests}}` removed (full run). `verify.gate` event carries `selectedTests`. Code: `verify/gates.ts` (`expandGateCommand`), `agent/runtime.ts#verify`.
- [x] S9-2 (DONE, selection.test) F-AGT-4 baseline: `.helix/verify.json` top-level `"baseline": true` (or task `baseline`) runs gates once before the first model turn → `baseline` artifact `{gates:[{name, passed, keys[]}]}` (key = file + normalized message, no line numbers). Retry prompt tags diagnostics `[pre-existing]`/`[new]`; gate `allowPreexisting: true` → a failure with only pre-existing diagnostics does not block. Skipped when the task already has checkpoints (resume after edits).
- [x] S9-3 (DONE) `test/selection.test.ts` 5/5 (expand/quote/fallback/diagnosticKey/config units; e2e: unrelated failing test skipped by selection; empty selection → fallback; baseline tags `[pre-existing]` and tolerates old lint debt; new diagnostic still blocks); engine 59/59, CLI 2/2, tsc clean. Live gemini-3.5-flash-lite on js-calc + always-red `test/unrelated.test.js` with `node --test {{tests}}` + `baseline:true`: fixed subtract, gate ran only `test/calc.test.js`, passed attempt 1 (9 calls, 22994 in / 301 out). Pushed to `helix/m1-session9`.
- Config example: `{"baseline": true, "gates": [{"name":"unit","kind":"test","command":"node --test {{tests}}","fallback":"npm test"}, {"name":"lint","kind":"lint","command":"npm run -s lint","allowPreexisting":true}]}`.
- Runtime API added: `runtime.changeset(task)`, `runtime.selectTests(task, root, index)`; events `verify.baseline`, `verify.gate.{selectedTests, changedFiles, preexisting, new}`, `verify.result.gates[].preexistingOnly`.

## Session 10 (M1) — live plan

Branch: `helix/m1-session10` from `main` (session 9 merged as PR #6).
- [x] S10-1 (DONE, code + ui.test) F-UI-2 activity monitor v0: RPC `task.monitor` → per task {status, elapsedMs, ledger, stepCount, currentStep, lastTool, pendingApprovals[], lastCheckpoint}; workbench "Monitor" view (default when nothing selected, topbar button) with live table, batch approve/deny of pending approvals, cancel/resume, open task. Code: engine RPC server + `ui/app.js` / `index.html` / `app.css`.
- [x] S10-2 (DONE, code) Gate panel shows `selectedTests`, changed files, pre-existing/new counts, `preexistingOnly`, and the `verify.baseline` run.
- [x] S10-3 DONE: engine 59/59, CLI 2/2, ui.test 2/2 incl. task.monitor assertions; tsc clean. Live: gemini-3.5-flash-lite task started from the workbench on a js-calc copy with an always-red unrelated test + `.helix/verify.json` (`baseline:true`, `node --test {{tests}}`): 7 calls, 16,458 in / 221 out, monitor showed running → done live; Gates tab showed baseline (unit failed, 2 diagnostics), selected tests `test/calc.test.js` only, changed `src/calc.js`, 0 new / 0 pre-existing, overall passed attempt 1. Browser fix: monitor relative times froze after tasks finished (tick now re-renders whenever visible). Note: ledger cost shows $0.0000 for gemini-3.5-flash-lite (no price entry) — pre-existing.

## Session 11 (M1) — live plan

Branch: `helix/m1-session11` from `main` (session 10 merged as PR #7).
Order (tick when done; next session resumes at the first unticked item):
- [x] S11-1 (DONE, code; tsc clean) `engine/src/workspace/files.ts`; `ExecOptions.onOutput`; Engine `knownWorkspace()` (registered workspaces only) + per-workspace terminal `LocalSandbox` destroyed on close; `terminal.kill {runId}`; runs aborted when the socket closes. RPC
- [x] S11-2 (DONE, code) Files + Terminal tabs in `ui/{index.html,app.js,app.css}`.
- [x] S11-3 Tests: `test/workbench-fs.test.ts` 2/2 (tree filters secrets/node_modules, read confinement incl. symlink escape + /etc/passwd + .env + byte cap, binary detect; WS: unknown workspace rejected, streamed stdout/stderr, exit code, kill, multi-byte not truncated). Browser + live: gemini-3.5-flash-lite task started from the workbench fixed js-calc copy (6 calls, 11,195 in / 180 out, `npm test --silent` passed attempt 1); Files tab listed 3 files and showed src/calc.js with line numbers; Terminal ran `npm test` (4 pass streamed), stderr in amber, `curl` failed DNS (sandbox has no network, as designed). Browser check found BUG-009 (below), fixed.
- [x] S11-4 DONE: engine 61/61 (incl. workbench-fs 2/2 + UTF-8 truncation regression), CLI 2/2, tsc clean. Pushed to `helix/m1-session11`. The `helix-workbench` service (port 4100) was re-registered in this VM.
- BUG-009 (fixed): `LocalSandbox.exec` set `truncated:true` for any multi-byte UTF-8 output (compared byte length to string length). Also affected agent `run_shell` summaries.
- Old S11-1 text: `fs.tree {workspace}` (git ls-files / walk, secret files filtered, cap 5000) + `fs.read {workspace, path}` (confined to workspace, 512 KB cap, binary detection) + `terminal.run {workspace, command}` (runs in a LocalSandbox for the workspace, streams `terminal.output` events, returns exit code; policy class exec, dev UI only).
- [ ] S11-2 Workbench: Files tab (tree + read-only viewer with line numbers) and Terminal tab (command input, streamed output, history).
- [ ] S11-3 Tests (ui.test: fs.tree/fs.read confinement, terminal.run output + exit) + browser check; push.
- Decision: gemini-3.5-flash-lite pricing stays `null` (no verified published price; do not invent one).

## Session 12 (M1) — live plan

Branch: `helix/m1-session12` from `main` (session 11 merged as PR #8).
Order (tick when done; next session resumes at the first unticked item):
- [x] S12-1 (DONE, code; tsc clean; extra guards: skip when the slice is < `minSliceTokens` (default 1024) and discard a compaction whose view is not smaller → `context.compaction_skipped`) F-CTX-2 compaction (`engine/src/context/compaction.ts` + `agent/runtime.ts#modelTurn`): trigger when the estimated request (system + transcript view + tools) exceeds `triggerTokens` (default 80% of the model contextWindow; Engine option `compaction` / env `HELIX_COMPACT_TRIGGER_TOKENS`); cut only at an assistant-turn boundary, keep the last `keepRecentTurns` (default 4) turns (so tool call/result pairs never split, current step never compacted); summarizer call (role `summarizer`, same model, no tools) returns `{decisions, factsLearned, filesTouched[{path,why}], openQuestions, failingChecks, userPreferences}`; parse failure/provider error → deterministic summary; user text copied verbatim into `constraints`; persisted as `compaction` artifact `{upTo, summary, constraints, source, tokensBefore, tokensAfter}` (originals stay in `messages`, restart-safe); `context.compacted` event.
- [x] S12-2 (DONE, compaction.test 4/4) Tests `test/compaction.test.ts` (cut selection, parse/fallback, e2e with fake Gemini: request after compaction starts with the summary and the goal verbatim, later requests reuse it).
- [x] S12-3 (DONE) Workbench file edit/save: `fs.read` now returns `hash` (sha256, null when truncated); `writeWorkspaceFile` + RPC `fs.write {workspacePath, path, content, baseHash}`: relative paths only, parent realpath confined (symlink escape refused), `.git`/secrets/host denylist refused, 2 MB cap, `FileConflictError` when `baseHash` ≠ current (null = must not exist), atomic temp+rename keeping mode; refused while a task is running in that workspace; audited `workspace.file_written`. UI: Edit/Save/Cancel in the Files tab, textarea editor, Ctrl/Cmd+S, Tab inserts 2 spaces, unsaved-changes confirm + beforeunload, conflict message. Binary/truncated files stay read-only.
- [x] S12-4 (DONE) engine 66/66 (compaction 4 + workbench-fs 3), CLI 2/2, tsc clean. Live gemini-3.5-flash-lite on a js-calc copy with `HELIX_COMPACT_TRIGGER_TOKENS=1500 HELIX_COMPACT_KEEP_TURNS=2 HELIX_COMPACT_MIN_SLICE_TOKENS=100`: 3 model-written compactions (1717→1645, 1761→1628, 1685→1403 est. tokens), task done, subtract fixed, tests untouched (9 steps, 12 calls, 16,356 in / 786 out). Browser: Files → Edit → Ctrl+S saved to disk; external change then Save → conflict message, disk content kept. CLI prints `⌁ compacted messages a–b (source): before → after tokens`.
- Limits: textarea editor (no syntax highlighting); CRLF files are saved with LF (browser textarea normalizes); user edits are not checkpointed (agent checkpoints only). Compaction eval (HTS ≤2 pp delta) not run — no HTS suite yet; token counts are the ~4 chars/token estimate.
- `helix-workbench` service re-registered in this VM: `node packages/engine/src/main.ts --ws 4100 --ui --host 0.0.0.0 --allow-host '*' --no-auth` (sources `.env.development.local`).

## Session 13 (M1) — live plan

Branch: `helix/m1-session13` from `main` (session 12 merged as PR #9).
Order (tick when done; next session resumes at the first unticked item):
- [x] S13-1 (DONE, code; tsc clean) F-MDL-4 role-based models: `engine/src/models/roles.ts` — layers `$HELIX_HOME/models.json` (user) < `<ws>/.helix/models.json` (workspace) < task `roles` override; org policy `$HELIX_HOME/policy.json` `{models:{allowProviders,denyProviders,allowModels,denyModels,forced}}` applied last (deny wins, `forced` replaces the binding). Refs are `provider/model` strings. Roles: planner, coder, explorer, reviewer, debugger, summarizer, embedder, completion, router; unset roles fall back to coder; coder falls back to task provider/model. Resolved bindings persisted as `roles` artifact at task create (restart-safe). Task model denied by policy → create fails.
- [x] S13-2 (DONE, code; `runtime.callRole`, `resolveTaskRoles`, `roles(t)`, RPC `models.roles {workspacePath|task}`, CLI `--role`) Runtime: `callRole()` tries primary then fallbacks on non-cancel ProviderError (after gateway retries) → `model.fallback` event; coder turns use role `coder` (`planner` in Plan Mode), compaction uses `summarizer`. Ledger already records role/provider/model per entry. RPC `models.roles {workspacePath, roles?}` (preview resolution); CLI `--role summarizer=gemini/<model>` (repeatable).
- Live (session 13, gemini-3.5-flash-lite, js-calc copy, `--role coder=gemini/gemini-0-nonexistent,gemini/gemini-3.5-flash-lite --role summarizer=gemini/gemini-3.5-flash-lite`, low compaction trigger): coder fell back on every turn (invalid_request, then breaker transient), 2 model compactions, subtract fixed, gate passed attempt 1 (7 steps, 10 calls, 14,901 in / 793 out). Policy `denyModels: ["gemini/*-pro*"]` + `-m gemini-3.5-pro` → "no allowed model for role 'coder'". Follow-up fix: permanent errors now demote the ref for the rest of the task. Note: task summary `model` shows the configured primary, not the model actually used (ledger has the real one).
- [x] S13-3 DONE: engine 69/69 (roles 3), CLI 2/2, tsc clean. Live re-check after demotion: one `⇢ coder ... invalid_request` fallback, then the fallback is used directly (5 steps, 5 calls, 9,782 in / 194 out, verify passed attempt 1). Pushed to `helix/m1-session13`.
- (spec) S13-3 Tests `test/roles.test.ts` (resolution order, policy deny/forced, invalid refs; e2e fake Gemini: summarizer on a different model, coder fallback on 5xx, ledger role per entry, denied model rejected). Full suite + tsc, live Gemini check, push.

## Session 14 (M1) — live plan

Branch: `helix/m1-session14` from `main` (session 13 merged as PR #10).
Order (tick when done; next session resumes at the first unticked item):
- STATUS: DONE (see S14-3).
- [x] S14-1 (DONE) Workbench role picker: "Roles" field in the New Task form (one `role=provider/model[,fallback]` per line, same syntax as CLI `--role`), live "Preview roles" via RPC `models.roles {workspacePath, model, roles}` showing the resolved binding + source per role; errors (policy deny, bad ref) shown inline, create blocked.
  As built: `<details id="roles-picker">` in the New Task form; `parseRolesText` in `ui/app.js` (validates role names, duplicates, empty model; `#` comments); 300 ms debounced preview on workspace/model/roles/policy change while the picker is open; roles inherited from coder are collapsed into one line; parse errors block submit and open the picker.
- [x] S14-2 (DONE) Task detail "Roles" tab: new RPC `models.usage {task}` (engine.ts) → `{bindings (roles artifact), usage[] (ledger grouped by role/provider/model: calls, failed, tokens, cost, first/last at), fallbacks[] (model.fallback events)}`. Table: configured chain + source vs actually used (marked `fallback` when not the primary), failed calls, tokens, cost; fallback list. Activity feed renders `model.fallback`. Re-renders on ledger/task events.
- [x] S14-3 DONE: ui.test extended (models.usage shape + coder binding source `task` + one usage row 3 calls; models.roles preview summarizer chain/inheritance; unknown role rejected); tsc clean. Browser + live gemini-3.5-flash-lite from the workbench on a js-calc copy with roles `coder=gemini/gemini-0-nonexistent,gemini/gemini-3.5-flash-lite` + `summarizer=gemini/gemini-3.5-flash-lite`: preview showed both overrides (source task) + "Inherit coder: …"; task done (7 steps, 7 calls, 16,255 in / 251 out, verify passed attempt 1); Roles tab: nonexistent 1 call / 1 failed, flash-lite 7 calls marked fallback, summarizer not used (no compaction at default trigger), 1 sticky fallback listed. Browser fix: `.sub` labels in the Roles table ran into the numbers ("1" + "1 failed" read as "11 failed").
- Note: `pnpm --filter @helix/engine test` hung with no child process in this VM (pnpm 12.3.4); run `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "test/**/*.test.ts"` from `packages/engine` directly.

## Session 15 (M1) — live plan

Branch: `helix/m1-session15-steps` from `main` (session 14 merged as PR #11). A parallel unmerged attempt exists on `helix/m1-session15` (`task.tree` RPC); merge only one.
Order (tick when done; next session resumes at the first unticked item):
- [x] S15-1 (DONE, code) F-UI-2 step/tool-call tree: RPC `task.steps {task}` (runtime `steps(id)`): steps ordered by idx with status/timing, ledger (role/provider/model/tokens/cost), assistant text, and tool calls (joined via the call ids in the step's assistant message → `tool_calls.call_id`; works for existing DBs since `tool_calls.step` stores `'tools'`). Calls requested but not yet run are `pending`.
- [x] S15-2 (DONE) Workbench "Steps" tab: collapsible Step → ToolCall tree (`<details>`), re-renders on step/tool/ledger events.
- [x] S15-3 DONE: ui.test 2/2 (task.steps: 3 steps idx 0..2, model ref per step, every call linked, `task is required`); tsc clean. Live gemini-3.5-flash-lite via the running workbench (WS client) on a js-calc copy: done, 7 steps (find_symbol, read_file×2, run_shell error, edit_file, run_shell ok, final), all calls linked; browser Steps tab renders the tree with per-step model/tokens/cost/duration. Pushed to `helix/m1-session15-steps`.

## Session 16 (M1) — live plan

Branch: `helix/m1-session16` (from `helix/m1-progress-fix`, which is pushed but not yet merged into `main`).
- [x] S16-1 F-TRM-1 PTY backend: `LocalSandbox.pty()` — util-linux `script -qfec` allocates a real PTY on the host around the same contained `bash -i` (user+net+mount ns, chroot, scrubbed env, TERM=xterm-256color). RPCs `pty.open {workspacePath, cols, rows}` / `pty.write {ptyId, data}` / `pty.kill {ptyId}`; notifications `pty.output {ptyId, data}`, `pty.exit {ptyId, exitCode}`; max 4 per connection, killed on disconnect. No PID namespace for PTYs (as ns init the shell can't own the PTY foreground group → Ctrl-C lost; verified by experiment); /proc stays unmounted.
- [x] S16-2 Workbench Terminal tab: "Interactive shell" (xterm.js 5.5 served from `/vendor/xterm.{js,css}` out of node_modules; CSP style-src now allows 'unsafe-inline' for xterm's injected styles, script-src still 'self'). Existing run-command panel kept.
- [x] S16-3 workbench-fs.test PTY assertions: tty + TERM + `stty size` = 20 90, Ctrl-C interrupts `sleep 30`, `exit 5` → pty.exit 5, write after exit rejects. workbench-fs + ui: 5/5 pass; tsc clean.
- [ ] S16-4 full engine suite, browser check, progress/feature table, push.

## Next Actions

Resume here for **M1 — Core MVP** (session 16). Session 15 shipped the workbench Steps tab (Step→ToolCall tree, RPC `task.steps`). Suggested start: PTY terminal (F-TRM-1), then F-SBX-3 egress proxy, then F-PRV-1/2 preview. Optional: persist demoted refs per task (survive Engine restart); task summary `model` could show the model actually used. Pricing for gemini-3.5-flash-lite stays `null` until a verified published price exists. Next, in order:
1. Remaining MCP (lower priority): MCP resources/prompts, OAuth for remote HTTP servers (F-AUTH-2), JSONPath projection of large results, workbench badge for tainted tasks.
2. Workbench follow-ups: checkpoint user edits + syntax highlighting + CRLF preservation, PTY for the terminal (interactive programs, colors), Electron shell + OS keychain (IMPL-ADR-010); F-UI-2 extensions (step/tool-call tree, pause, fork from checkpoint, change model).
3. Polish: `--verify auto` could emit `{{tests}}` gates for known runners (node --test, pytest, go test pkg selection); graph evidence in Plan Mode `affectedFiles`; tree-sitter extractor swap; gate result cache by (gate, inputs hash) (§9.6).
4. F-CTX-2 HTS eval, F-MDL-4 role-based models, F-SBX-3 egress proxy, F-PRV-1/2 preview.

Workbench: `node --disable-warning=ExperimentalWarning packages/engine/src/main.ts --ui` prints `http://127.0.0.1:<port>/#token=…`. In the v0 sandbox the registered service `helix-workbench` runs it on port 4100 with `--host 0.0.0.0 --allow-host '*' --no-auth` (dev preview only; sources `.env.development.local` for `GEMINI_API`).
Roles: `--role coder=gemini/a,gemini/b --role summarizer=gemini/c`; files `$HELIX_HOME/models.json`, `<ws>/.helix/models.json` (`{"roles":{...}}`), org policy `$HELIX_HOME/policy.json` (`{"models":{"denyModels":["gemini/*-pro*"]}}`); RPC `models.roles {workspacePath}` previews resolution, `{task}` returns the persisted bindings.
How to run: `pnpm --filter @helix/engine test` (69 tests), `pnpm --filter @helix/cli test`, `pnpm --filter @helix/provider-conformance test`, `npx tsc -p tsconfig.helix.json`.
Live: `set -a; . ./.env.development.local; set +a; node --disable-warning=ExperimentalWarning evals/m0-exit.ts --model gemini-3.5-flash-lite` (key env var: `GEMINI_API`).
Compaction env: `HELIX_COMPACT_TRIGGER_TOKENS`, `HELIX_COMPACT_KEEP_TURNS`, `HELIX_COMPACT_MIN_SLICE_TOKENS`, `HELIX_COMPACT=off` (Engine option `compaction`).
MCP: `helix mcp add <name> [--trusted] -- <cmd...>` or `helix mcp add <name> --url <url> --header K=V`; `helix mcp list`; `helix mcp remove <name>`; mcp.json keys `allowTools`, `denyTools`, `alwaysAllow`, top-level `toolSearchThreshold`.
CLI: `apps/cli/bin/helix -p "fix the failing test" -C <repo> --verify "<test cmd>" -m gemini-3.5-flash-lite`; `--plan` for Plan Mode; `helix search "<q>" -C <repo>`; `helix symbols <name> -C <repo>`; `helix impact <symbol|file> -C <repo>`; `--verify auto` or `.helix/verify.json` for gates; `helix checkpoints|restore <task>`.
