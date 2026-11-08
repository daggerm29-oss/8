# Helix — Progress

> Read `AGENTS.md` first. This file is **replaced, not appended**. Keep it under 150 lines.
> Old session-by-session log: `docs/history/progress-sessions-1-16.md` (read only if debugging history).
> Decisions (IMPL-ADR-*) and known issues: `docs/decisions.md`.

## Status

- Milestone: **M1 — MVP (trimmed scope, see below)**
- M1 progress: **0 / 7 remaining tasks done** (everything else in M1 scope is already built)
- Last updated: 2026-11-08 (workflow reset)
- Branch convention: `helix/m1-<task-id>` from `main`, one PR per task

## M1 definition of done (AI-verifiable)

M1 is done when all 7 tasks below are checked AND this demo passes end to end in the workbench:

1. Open the workbench, pick the `fixtures/` web app workspace.
2. Ask the agent: "change the page heading to Hello Helix".
3. The agent installs deps through the egress proxy, starts the dev server, edits the file.
4. The preview panel shows the new heading; the agent's screenshot tool confirms it; verify gates pass.
5. The user commits from the Git panel.

Human evals (O1/O2 benchmarks, 10-user usability study) are a **launch gate**, not an M1 build task.

## Remaining M1 tasks (do the first unchecked one)

- [ ] **T1 F-SBX-3 egress proxy** — arch §16.5. Engine-hosted HTTP+CONNECT proxy (`packages/engine/src/sandbox/egress.ts`, node:http/net only, no TLS termination). Default allowlist: registry.npmjs.org, pypi.org, files.pythonhosted.org, github.com, codeload.github.com. Bridge into `unshare --net` via a bind-mounted Unix socket + tiny in-sandbox TCP→unix forwarder; set `HTTP(S)_PROXY`/`npm_config_proxy` in `LocalSandbox.env()`. Denied host → `egress.denied` event; RPC `egress.allow {workspacePath, host}` persisted (new migration).
  - Accept: allowlisted `curl https://registry.npmjs.org/` works in sandbox; other host denied + reported; `curl --noproxy '*'` fails. New `test/egress.test.ts`.
- [ ] **T2 F-PRV-1 dev server start** — arch §17.2. Detect `dev`/`start` script (package.json) or Vite/Next, start it in the sandbox on a free port, report the URL via event `preview.ready`. Tool `start_dev_server` for the agent.
  - Accept: test fixture web app starts and responds on localhost.
- [ ] **T3 F-PRV-2 preview panel** — arch §17.1, §17.3. Workbench "Preview" tab = iframe of the dev-server URL + reload button. One tab only (multi-tab is M2).
  - Accept: browser check shows the fixture page inside the workbench.
- [ ] **T4 F-PRV-5 browser tools (minimal)** — arch §18.5. Agent tools `preview_screenshot` and `preview_console` (headless Chromium via CDP if available, else Playwright). No recording, no telemetry dashboards.
  - Accept: agent can take a screenshot and read console errors of the fixture page.
- [ ] **T5 F-GIT-1 + F-GIT-5 Git panel (minimal)** — arch §20.1, §20.6. Workbench "Git" tab: status, diff, stage all, commit message, commit. Block force-push and pushes to main from agent tools.
  - Accept: commit from the panel shows in `git log`; agent `git push --force` is denied.
- [ ] **T6 F-ORC-1 Explore subagent** — arch §10.2. Read-only subagent (find_symbol, code_search, read_file) callable as tool `explore {question}` returning a short summary. No DAG, no parallelism.
  - Accept: test with fake model shows parent receives the explore summary; subagent has no write tools.
- [ ] **T7 M1 demo eval** — add `fixtures/m1/web-hello` (tiny Vite or plain node static app) + `evals/m1-demo.ts` running the definition-of-done flow live with Gemini.
  - Accept: eval passes once live; result saved in `evals/results/`.

When all 7 are checked: set milestone to M2 and copy the M2 list from `plan.md` §12 into this file, trimmed the same way (max ~8 tasks).

## Already built in M1 (do not rework)

Agent loop, Plan Mode, self-correct, verification gates + baseline, test selection; sandbox containment, lifecycle; Gemini + OpenAI (API key) adapters, roles + fallback, ledger, budgets; heuristic index + hybrid search + code graph; context assembler, compaction, project instructions; checkpoints + restore; MCP stdio/HTTP, permissions, tool search, caching, injection defense; diagnostic parsers; web workbench (tasks, monitor, steps, diff, files edit, run-command + PTY terminal, roles, approvals).

## Deferred out of M1 (do NOT build now)

Electron desktop shell + OS keychain (web workbench is the M1 shell) · tree-sitter swap · vector embeddings (F-IDX-6) · CDP telemetry + Environment Snapshot (F-PRV-3/4) · multi-tab preview · skills/hooks (F-AGT-5) · OSV dependency gate (F-REV-3) · deterministic-first policy (F-TOK-3) · Artifacts view (F-UI-4) · PTY history indexing + live resize · SIWC · everything listed under M2–M6 in plan.md.

## Ideas parking lot (one line each, max 15 — do not implement)

- MCP resources/prompts, OAuth for remote MCP servers
- Workbench: syntax highlighting, CRLF preservation, checkpoint user edits, pause/fork task
- `--verify auto` emitting `{{tests}}` gates; graph evidence in Plan Mode
- Persist demoted model refs per workspace

## How to run

- Typecheck: `npx tsc -p tsconfig.helix.json`
- Focused test: `cd packages/engine && node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/<file>.test.ts`
- Full engine suite (end of task only, ~5–8 min, timeout ≥ 600 s): same command with `"test/**/*.test.ts"` (`pnpm test` can hang in the v0 VM)
- CLI tests: `pnpm --filter @helix/cli test`
- Workbench (service `helix-workbench`, port 4100): `bash -lc "set -a; . ./.env.development.local; set +a; exec node --disable-warning=ExperimentalWarning packages/engine/src/main.ts --ws 4100 --ui --host 0.0.0.0 --allow-host '*' --no-auth"`
- Live model: env `GEMINI_API`, model `gemini-3.5-flash-lite` (free tier ~20 req/day per model)

## Current blockers / notes

- None. Environment: no Docker; `unshare` works; no cgroups; no /proc in sandbox (see `docs/decisions.md`).

## Last session (overwrite each session, max 5 lines)

- 2026-11-08: Workflow reset. Old 76-feature tracker counted M2–M6 features against M1, so M1 % could never reach 100. Trimmed M1 to 7 tasks, moved history and decisions out, added `AGENTS.md` rules.
