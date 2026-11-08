# Helix — Roadmap checklist (single source of truth for progress)

> Percentages in `progress.md` are computed from this file by `node scripts/progress.mjs`. Never type percentages by hand.
> Only **top-level** checkboxes (`- [ ]` at the start of a line) are counted. Indented sub-bullets are for splitting work and are not counted.
> Do not add, remove, or reword top-level items unless the user asks. Tick an item only when its Accept line passes.
> Every ticked item needs an indented evidence line directly under it, or the script does not count it:
> `  - Evidence: <test/eval command> → <actual result, e.g. "12/12 pass">; commit <sha>; artifact <path, if any>`
> Items marked "(deferred from M1)" were cut from the original M1 spec to ship the MVP sooner; they are still required scope.
> Scope source: `plan.md` §12. Architecture refs are in brackets.

## M0 — Foundations

- [x] Monorepo + `@helix/protocol` JSON-RPC (WebSocket/stdio)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Engine core: SQLite storage, migrations, blob store, event bus, audit chain
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] OTel-compatible tracer + redacting logger
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Provider adapter framework + conformance suite (F-MDL-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Gemini adapter (F-MDL-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] OpenAI adapter, API-key mode (F-MDL-3)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Local sandbox v0 (F-SBX-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Tool framework: fs, shell, exact search
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Primary agent loop + restart resume (F-AGT-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Ledger v0 (F-TOK-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] CLI `helix -p` + live M0 exit eval (3/3 fixtures)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)

## M1 — MVP, grounded single agent

- [x] Plan Mode (F-AGT-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Self-correction loop (F-AGT-3)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Verification gates + baseline (F-AGT-4)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Whole-toolchain containment (F-SBX-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Sandbox lifecycle + resources (F-SBX-5)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Symbol index, heuristic (F-IDX-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Hybrid retrieval (F-IDX-4)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Budgeted context assembler (F-CTX-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Compaction (F-CTX-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Project instructions (F-CTX-3)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Shadow checkpoints + restore (F-GIT-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] MCP client stdio/HTTP (F-MCP-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] MCP permissions (F-MCP-3)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Human approvals (F-ORC-4)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Budgets (F-TOK-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Role-based models + fallback (F-MDL-4)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Diagnostic parsers (F-TRM-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Web workbench: tasks, monitor, steps, diff, file edit, roles, approvals (F-UI-1/2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Terminal: run-command + PTY (F-TRM-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] **T1 Egress proxy (F-SBX-3)** [§16.5] — Engine HTTP+CONNECT proxy (`packages/engine/src/sandbox/egress.ts`, node:http/net only, no TLS termination). Default allowlist: registry.npmjs.org, pypi.org, files.pythonhosted.org, github.com, codeload.github.com. Bridge into `unshare --net` via bind-mounted Unix socket + in-sandbox TCP→unix forwarder; set `HTTP(S)_PROXY`/`npm_config_proxy` in `LocalSandbox.env()`. Denied host → `egress.denied` event; RPC `egress.allow {workspacePath, host}` persisted (new migration). Accept: allowlisted `curl https://registry.npmjs.org/` works in sandbox; other hosts denied and reported; `curl --noproxy '*'` fails; new `test/egress.test.ts` passes.
  - Evidence: `node --test test/egress.test.ts` → 3/3 pass (registry.npmjs.org 200 via proxy; example.com 403 + `egress.denied`; `--noproxy '*'` fails; 169.254.169.254 403; `egress.allow` persisted then example.com 200); full engine suite 72/72 pass; commit ad36776
- [x] **T2 Dev server start (F-PRV-1)** [§17.2] — Detect `dev`/`start` script or Vite/Next, start in sandbox on a free port, emit `preview.ready {url}`; agent tool `start_dev_server`. Accept: fixture web app starts and responds on localhost.
  - Evidence: `node --test test/devserver.test.ts` → 4/4 pass (fixture `npm run dev` starts in sandbox, `GET http://127.0.0.1:<free port>/` → 200 "Hello fixture"; `preview.ready` event; `start_dev_server` tool returns URL; crash reported with output); full engine suite 76/76 pass; commit fbc749f
- [x] **T3 Preview panel (F-PRV-2)** [§17.1, §17.3] — Workbench "Preview" tab: iframe of dev-server URL + reload. One tab only. Accept: browser check shows the fixture page inside the workbench.
  - Evidence: agent-browser on workbench `:4100` → task in `/tmp/t3-fx`, Preview tab → "Start dev server" → status `npm run dev → http://127.0.0.1:37499/`, iframe visible showing "Hello fixture"; commit 721770f; artifact evals/results/t3-preview-tab.png
- [x] **T4 Browser tools, minimal (F-PRV-5)** [§18.5] — Agent tools `preview_screenshot`, `preview_console` (headless Chromium via CDP, else Playwright). No recording. Accept: agent takes a screenshot and reads console errors of the fixture page.
  - Evidence: `node --test test/browser.test.ts` → 1/1 pass (fake-model agent: preview_screenshot before server → error; start_dev_server; preview_screenshot → PNG saved, title "Fixture App", text "Hello fixture", `[error] fixture console error`; preview_console → log, console.error and uncaught exception; off-origin URL rejected); `npx tsc -p tsconfig.helix.json` → 0 errors; commit 69cce75
- [x] **T5 Git panel, minimal (F-GIT-1, F-GIT-5)** [§20.1, §20.6] — Workbench "Git" tab: status, diff, stage all, commit. Agent tools cannot force-push or push to main. Accept: commit from panel appears in `git log`; agent `git push --force` is denied.
  - Evidence: agent-browser on workbench `:4100`, Git tab in `/tmp/t5-repo` → status ` M index.html`/`?? NOTES.md` → Stage all → Commit "Change heading to Hello Helix" → `git log --oneline -1` = `4dcf197 Change heading to Hello Helix`; `node --test test/git.test.ts` → 3/3 pass (RPC status/diff/stage/commit in git log, pre-commit hook not run; fake-model agent `git push --force` and `git push origin main` → "denied by policy" even with preapprove all); tsc 0 errors; commit b28d628; artifact evals/results/t5-git-panel.png
- [x] **T6 Explore subagent (F-ORC-1)** [§10.2] — Read-only subagent (find_symbol, code_search, read_file) as tool `explore {question}` returning a short summary. No DAG. Accept: fake-model test shows parent gets the summary and subagent has no write tools.
  - Evidence: `node --test test/explore.test.ts` → 1/1 pass (fake model: parent calls `explore`, subagent request offers only code_search/find_symbol/read_file, brief = question only, its `write_file` call rejected and no file written, find_symbol ran; parent transcript has one tool_result = the summary); tsc 0 errors; commit f20d77a
- [x] **T7 M1 demo eval** — `fixtures/m1/web-hello` + `evals/m1-demo.ts`: open workspace, ask "change the page heading to Hello Helix", agent installs deps via proxy, starts dev server, edits, screenshot confirms, gates pass, commit from Git panel. Accept: passes once live with Gemini; result in `evals/results/`.
  - Evidence: `node evals/m1-demo.ts` (live gemini-3.5-flash-lite) → M1 DEMO: PASS, 7/7 checks (npm install via egress proxy, start_dev_server, edit_file src/page.js, preview_screenshot text "Hello Helix", `npm test` gate passed attempt 1, git.stageAll+git.commit RPC → `6adc651 Change heading to Hello Helix`), 7 model calls, 9 s; first attempt failed screenshot check (fixture dev script had no reload) → fixed to `node --watch`; commit 92e787a; artifact evals/results/m1-demo-gemini-2026-11-08T13-54-03-813Z.json, evals/results/m1-demo-2026-11-08T13-54-03-813Z.png

Launch gates (human, not counted): O1/O2 benchmarks, 10-user usability study, original M1 exit criteria from plan.md §12 (benchmark targets, eval suite).

## M2 — Precision and efficiency

- [x] MCP tool search (F-MCP-2)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] MCP result compression + cache (F-MCP-4)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] MCP prompt-injection defense (F-MCP-5)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Code graph v0 + `impact` tool (F-IDX-3)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [x] Change-based test selection (F-TST-1)
  - Evidence: legacy, built in sessions 1–16 before evidence rule (see docs/history/progress-sessions-1-16.md)
- [ ] Precise references via SCIP/LSP (F-IDX-2) [§11.4]
- [ ] Impact Report attached to Plan Mode artifacts [§11.5]
- [ ] tree-sitter parser swap for the symbol index [§11.2] (deferred from M1)
- [ ] Local-first vector embeddings in hybrid retrieval (F-IDX-6) [§12.3] (deferred from M1)
- [ ] Domain extractors (F-IDX-5) [§11.7]
- [ ] Runtime telemetry via CDP + Environment Snapshot (F-PRV-3/4) [§18.3] (deferred from M1)
- [ ] Element→source + select-and-instruct in preview [§17]
- [ ] Credential masking via TLS-terminating proxy (F-SBX-4) [§16.6]
- [ ] Model router v1 (F-MDL-5) [§7.6]
- [ ] Session replay [§30]
- [ ] Artifacts view v2 with structured evidence (F-UI-4) (deferred from M1)
- [ ] Test generation (F-TST) [§19]
- [ ] Skills and hooks (F-AGT-5) [§9.7] (deferred from M1)
- [ ] OSV dependency gate (F-REV-3) (deferred from M1)
- [ ] Electron desktop shell + OS keychain (F-AUTH-1) (deferred from M1)
- [ ] Windows support
- [ ] M2 eval: cost vs baseline, MCP tokens ≤ 3k/turn at 200 tools, element→source ≥ 95% on fixtures

Launch gates (human, not counted): Sign in with ChatGPT (needs OpenAI approval), O3/O5 benchmarks.

## M3 — Parallel and background

- [ ] General subagents + task DAG scheduler (F-ORC-2) [§10.3]
- [ ] Write leases + worktrees + merge agent (F-ORC-3) [§10.4]
- [ ] Cloud sandbox provider (+ self-hosted Firecracker option) [§16]
- [ ] Local and cloud background workers, durable across restarts (F-ORC-5) [§10.6]
- [ ] Schedules and triggers [§10.6]
- [ ] Visual regression [§19]
- [ ] Bug auto-repro [§19]
- [ ] E2E tests from recordings [§19]
- [ ] Fix-history / typed project memory (F-CTX-4) [§13.6]
- [ ] Architecture diagrams
- [ ] Inline completion v1
- [ ] M3 eval: 300-file migration with zero lost writes; visual regression false positives ≤ 5%

## M4 — Team and ecosystem

- [ ] Helix Cloud control plane: orgs, RBAC, policies, audit export
- [ ] SSO + SCIM (F-AUTH-3) [§8.5]
- [ ] OAuth broker (F-AUTH-2) [§8.2]
- [ ] PR review bot: GitHub App, then GitLab
- [ ] Deploy adapters
- [ ] Shared memory and skills
- [ ] Auto ADRs
- [ ] App scaffolding templates + integration wizards
- [ ] Learned routing priors (opt-in data)

Launch gates (human, not counted): 3 design-partner pilots, SOC 2 Type I readiness, external pen test.

## M5 — Platform

- [ ] Agents-as-code SDK on the Helix Engine
- [ ] Execution-flow visualization
- [ ] Specialist small models: rerank, routing, diagnostics extraction
- [ ] Mobile remote control
- [ ] Curated marketplace for skills and MCP bundles

## M6 — Collaboration

- [ ] Multiplayer sessions (CRDT)
- [ ] Voice input
- [ ] Enterprise data-residency regions
- [ ] On-prem control plane
