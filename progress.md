# HELIX — Development Progress

> **Read this first.** This file is the single source of truth for what is actually implemented. `plan.md` is the product spec, and `architecture.md` is the technical blueprint. A status of **Verified** means an automated or manual check proved the acceptance criteria. Written code alone is at most **Implemented**.

## Project Status

- Project: Helix
- Current Phase: M1 — Core MVP (engine-side slice in progress)
- Overall Completion: ~20% (M0 Verified; M1 ~55%: engine slice + web workbench v0)
- Current Status: M1 session 6 — F-UI-1 web workbench v0 + F-MCP-1 stdio MCP client Tested (live Gemini runs from the UI)
- Last Updated: 2026-11-06 (session 6)
- Current Development Branch: `helix/m1-session6` (base: `main` of github.com/daggerm29-oss/8)

## Phase Overview

| Phase | Name | Status | Completion |
|---|---|---|---|
| M0 | Engineering Foundations | Verified (exit criteria met live, 2026-11-06) | 100% |
| M1 | Core MVP | In Progress | ~50% engine-side; desktop UI, MCP, preview, egress proxy not started |
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
| F-MDL-4 | Role-based model configuration | Not Started | — | Arch §7.5 |
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
| F-CTX-2 | Compaction | Not Started | — | Arch §13.4 |
| F-CTX-3 | Project instructions | Tested | m1.test (instructions, runtime) | `$HELIX_HOME/HELIX.md` → root AGENTS.md/HELIX.md → nested; truncation warning. Nested files for edited paths are loaded only at compose time (touchedPaths API exists). Arch §13.5 |
| F-CTX-4 | Typed project memory | Not Started | — | Arch §13.6 |
| F-AGT-1 | Primary agent loop | Tested | agent.test (7), cli.test (2) | M0 scope: transcript-derived state machine, per-step persistence, task-level backoff on 503/429. Arch §9.1–9.3, §30.1 |
| F-AGT-2 | Plan Mode | Verified | m1.test (plan mode); live gemini-3.5-flash-lite plan task | Write tools absent from the tool list + policy deny; `submit_plan` → plan artifact with `unverifiedPaths`; CLI `--plan`, `helix plan`. No graph evidence yet (F-IDX-3). Arch §9.4 |
| F-AGT-3 | Self-correction loop | Tested | agent.test, m1.test (diagnostics retry) | Retry prompt = structured diagnostics + 40-line tail (no full logs), max 3 attempts. Minimal-diff-since-green not yet. Arch §9.5 |
| F-AGT-4 | Verification gates | Tested | agent.test, gates.test (3) | Configurable gates: `.helix/verify.json` or `--verify auto` (inferred from package.json/tsconfig/go.mod/Cargo.toml/python) or a single `--verify cmd`; required vs optional, per-gate timeout + parser, all gates each attempt, `verify.gate` events. No baseline (pre-existing failure) detection or change-based test selection yet. Arch §9.6 |
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
| F-TRM-1 | Integrated terminal | In Progress | sandbox.test | M0: non-PTY `run_shell` execution only; PTY terminal is M1. Arch §19.1–19.3 |
| F-TRM-2 | Diagnostic parsers | Tested | m1.test (diagnostics) | tsc, node:test (TAP/spec), pytest, unittest, eslint (stylish), go, generic + Python traceback; RPC `diagnostics.parse`. LLM fallback extraction not yet. Arch §19.4 |
| F-GIT-1 | Source control panel | Not Started | — | Arch §20.1–20.2, §5.2 |
| F-GIT-2 | Shadow checkpoints | Tested | agent.test, m1.test (restore) | Pre-images per write; `restore(task, cp?)` atomic temp+rename, deletes agent-created files, saves pre-restore content (undoable); RPC + CLI. shadow.git + 3-way merge for user edits pending. Arch §20.3 |
| F-GIT-3 | Worktree manager | Not Started | — | Arch §20.4 |
| F-GIT-4 | PR integration | Not Started | — | Arch §20.5 |
| F-GIT-5 | Git safeguards | Not Started | — | Arch §20.6 |
| F-MCP-1 | MCP client manager | In Progress | mcp.test (3); live Gemini via workbench (session 6) | stdio transport + manager + `mcp.list` done; streamable HTTP not started. Arch §14.1–14.3 |
| F-MCP-2 | Tool registry and tool search (X7) | In Progress | sandbox.test, m1.test, graph.test | `ToolRegistry` + 10 builtin tools (+ find_symbol, code_search, impact, submit_plan); tool search not started. Arch §14.4, §15.2 |
| F-MCP-3 | Permissions and trust tiers | In Progress | mcp.test | v0: MCP tools = `network`; trusted+readOnlyHint = `read`; `registerToolClass` in policy.ts. Per-tool lists not started. Arch §14.6 |
| F-MCP-4 | Result normalization, compression, caching | Not Started | — | Arch §15.4 |
| F-MCP-5 | Injection defense | Not Started | — | Arch §25.6 |
| F-TOK-1 | Token ledger | Verified | engine models.test: totals reconcile exactly with provider-reported usage (Gemini + OpenAI fakes) | Live: ledger tokens == sum of raw Gemini usageMetadata for all 3 exit tasks. Per-attempt rows, provider vs estimate source, cost from manifest pricing, `ledger.entry` events. Arch §29.1, §29.6 |
| F-TOK-2 | Budgets | Tested | engine models.test: hard USD/token block before the provider call; soft threshold audit event | M0 subset: task + day scopes, pre-call check. Arch §29.6 |
| F-TOK-3 | Deterministic-first policy | Not Started | — | Arch §29.2, §15.5 |
| F-TOK-4 | Prompt-cache optimizer | Not Started | — | Arch §29.4 |
| F-VIS-1 | Element→source mapping (X2) | Not Started | — | Arch §18.6 |
| F-VIS-2 | Select-and-instruct | Not Started | — | Arch §18.6 |
| F-VIS-3 | Visual regression (X10) | Not Started | — | Arch §18.7 |
| F-VIS-4 | UI consistency analysis | Not Started | — | Arch §18.7 |
| F-TST-1 | Change-based test selection | Not Started | — | Arch §11.5, §9.6 |
| F-TST-2 | Test generation | Not Started | — | Arch §9.6 |
| F-TST-3 | Browser E2E from recordings (X16) | Not Started | — | Arch §18.5 |
| F-TST-4 | Bug auto-reproduction (X11) | Not Started | — | Arch §9.5 |
| F-REV-1 | Review agent | Not Started | — | Arch §10.2 |
| F-REV-2 | Security analysis | Not Started | — | Arch §25.10 |
| F-REV-3 | Dependency risk gate (X17) | Not Started | — | Arch §16.7 |
| F-UI-1 | Workbench | Tested | ui.test (2); browser + live Gemini run (session 6) | v0 web workbench served by the Engine (`packages/engine/ui/`, no build): task create/list, live event stream, transcript, diff per checkpoint + restore, gates, approvals, impact explorer, artifacts, ledger stats. Fragment token, Host/Origin loopback check, CSP. No editor/terminal/Electron yet. Arch §5.1–5.3 |
| F-UI-2 | Agent activity monitor | Not Started | — | Arch §5.4 |
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
| ISSUE-006 | CLI misses `context.composed` for a new task: the event fires before the CLI learns the task id and installs its filter | Low | CLI | Race between task.create response and the first events | Open | Buffer events by task until the id is known, or replay with `events.replay` |
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
| workbench | unifiedDiff cases; UI served without token, foreign Host/Origin 403, token-gated WS, events over socket, checkpoint.diff whole/partial/after-restore, workspace/approval list | Test passed (2/2) | `ui.test.ts`, session 6 |
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

## Next Actions

Resume here for **M1 — Core MVP** (session 7). Session 6 shipped F-UI-1 workbench v0 (see Session 6 list). Next, in order:
1. MCP follow-ups: streamable HTTP transport (F-MCP-1 part 2), per-tool allow/deny lists in mcp.json + approval UI "always allow" (F-MCP-3), F-MCP-2 tool search when tool count is large, F-MCP-4 result caching; MCP resources/prompts; `helix mcp list|add` CLI.
2. Workbench follow-ups: F-UI-2 agent activity monitor (multi-task), Monaco/CodeMirror file view, PTY terminal panel (F-TRM-1), Electron shell + OS keychain (IMPL-ADR-010).
3. Polish of priorities 2-3: baseline gate run (pre-existing failures), F-TST-1 change-based test selection from `impact().tests`, graph evidence in Plan Mode `affectedFiles`, tree-sitter extractor swap.
4. F-CTX-2 compaction, F-MDL-4 role-based models, F-SBX-3 egress proxy, F-PRV-1/2 preview.
Fix ISSUE-006 when touching the CLI.

Workbench: `node --disable-warning=ExperimentalWarning packages/engine/src/main.ts --ui` prints `http://127.0.0.1:<port>/#token=…`. In the v0 sandbox the registered service `helix-workbench` runs it on port 4100 with `--host 0.0.0.0 --allow-host '*' --no-auth` (dev preview only; sources `.env.development.local` for `GEMINI_API`).
How to run: `pnpm --filter @helix/engine test` (48 tests), `pnpm --filter @helix/cli test`, `pnpm --filter @helix/provider-conformance test`, `npx tsc -p tsconfig.helix.json`.
Live: `set -a; . ./.env.development.local; set +a; node --disable-warning=ExperimentalWarning evals/m0-exit.ts --model gemini-3.5-flash-lite` (key env var: `GEMINI_API`).
CLI: `apps/cli/bin/helix -p "fix the failing test" -C <repo> --verify "<test cmd>" -m gemini-3.5-flash-lite`; `--plan` for Plan Mode; `helix search "<q>" -C <repo>`; `helix symbols <name> -C <repo>`; `helix impact <symbol|file> -C <repo>`; `--verify auto` or `.helix/verify.json` for gates; `helix checkpoints|restore <task>`.
