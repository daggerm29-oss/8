# OpenHands Reuse — Persistent Research Handoff

> **Read this first in every new session.** Branch: `research/openhands-reuse-audit` (docs only, based on `main`). Full report: `docs/research/openhands/audit-m0-m1.md`.
> Research-only artifact. It never overrides `plan.md` > `architecture.md` > `docs/roadmap.md` > `AGENTS.md`. **Only O1/O2 are approved, and only as design inputs for their roadmap tasks (see §5 Decision log); no code implementation is approved yet.** Do not touch PR #23, product code, plan/architecture/roadmap/AGENTS, or checkboxes from this branch.

## 1. Executive summary

- **Helix state (PR #23 head `71616a64d39a0839a28a3911ca728a8619f0d850`, draft, branch `helix/session-2026-11-10-m1-workbench`):** TS/Node 24 Engine (JSON-RPC, SQLite, event bus + audit chain, policy, tool registry, transcript-derived agent runtime, fail-closed sandboxes with egress proxy, credential sentinels, cgroups, hard quota on local-unshare) + Electron/React workbench. Dashboard 41% (81/198, tasks only). M0: all done except **R0.8 CI, postponed by user decision** (Accept unchanged; do not reopen). M1: T1–T7, R1.1–R1.10 done incl. R1.8a; open R1.8b, R1.11 (wip) … R1.47, gates G1.1–G1.6.
- **OpenHands topology (verified):** Python core in `software-agent-sdk` (sdk, tools, agent-server, workspaces, TS client); `OpenHands/OpenHands` is now Agent Canvas (React + Electron client, ACP agents); `sandbox-server` = extracted FastAPI control plane; `automation` = cron/webhooks. All MIT.
- **Conclusion:** do **not** integrate the OpenHands SDK/agent server/workspaces (second orchestration engine, Python runtime, weaker containment). Borrow a few self-contained algorithms + test vectors into TS behind existing Helix interfaces: **O1 shell AST rails (R1.30/R1.36)**, **O2 loop detector (R1.17)**, **O3 split-chunk stream masking (isolated repro first, parked)**. **O4 V4A / `apply_patch` parser is NOT approved (Q3); R1.19 keeps Helix's native atomic changeset.** Everything else stays native.
- **Decisions:** all seven questions (Q1–Q7) are answered; see §5 "Decision log". Nothing is open except the user-gated next steps in §6. The benchmarks audit (R1.39) is complete: `docs/research/openhands/audit-benchmarks-r1-39.md`.

## 2. Pinned source references

| Key | Repo @ SHA | Path(s) | Symbols / lines | Licence | Runtime deps upstream |
|---|---|---|---|---|---|
| O1 | `OpenHands/software-agent-sdk` @ `2cca5ba058bef0fcafb553b0bbcbf5f3ffc84a53` | `openhands-sdk/openhands/sdk/security/defense_in_depth/policy_rails.py`; `.../defense_in_depth/shell_semantics.py`; `.../security/_shell_ast.py`; `.../security/shell_parser.py`; tests `tests/sdk/security/defense_in_depth/test_policy_rails.py`, `test_shell_semantics.py` | `_evaluate_rail` l.877, `_scan_fetch_pipelines` l.450, `_scan_catastrophic_delete` l.808, `_scan_raw_disk` l.785, `_resolve_wrappers` l.306, `PolicyRailSecurityAnalyzer` l.891; `parse` (`shell_parser.py` l.58) | MIT © 2026 OpenHands contributors | `tree-sitter>=0.25`, `tree-sitter-bash>=0.25` (Python) → Helix uses `@vscode/tree-sitter-wasm` 0.3.1 Bash (already a dependency) |
| O2 | same | `openhands-sdk/openhands/sdk/conversation/stuck_detector.py`; tests `tests/cross/test_stuck_detector.py`, `tests/cross/test_stuck_detector_config.py`, `tests/sdk/conversation/local/test_stuck_detector_nudge.py` | `StuckDetector` l.27, `is_stuck` l.109, `_is_stuck_repeating_action_observation` l.157, `_is_stuck_repeating_action_error` l.333, `_is_stuck_monologue` l.385, `_is_stuck_alternating_action_observation` l.412, `_is_stuck_context_window_error` l.452 | MIT | none beyond SDK events |
| O3 | same | `openhands-sdk/openhands/sdk/conversation/secret_registry.py` | `StreamOutputMask` l.117-160 (holds back `max_len-1` suffix) | MIT | `re` |
| O4 | same (adaptation) / **original:** `openai/openai-cookbook` `examples/gpt-5/apply_patch.py` (SHA not yet pinned) | `openhands-tools/openhands/tools/apply_patch/core.py`; tests `tests/tools/apply_patch/test_apply_patch_executor.py` | `Parser` l.85, `text_to_patch` l.340, `patch_to_commit` l.415, `apply_commit` l.466, `process_patch` l.490 | OpenHands MIT; **cookbook licence to verify** | pydantic |
| O5 | same | `openhands-sdk/openhands/sdk/skills/skill.py`; `.../skills/utils.py` | `PATH_TO_THIRD_PARTY_SKILL_NAME` l.349-355, `_handle_third_party` l.638, `load_project_skills` l.1076; `find_third_party_files` l.351, `find_nested_third_party_files` l.449 | MIT | — (no `.mdc` support upstream) |
| O6 | same | `openhands-tools/openhands/tools/browser_use/{definition,impl,recording}.py`, `js/{rrweb-loader,start-recording,stop-recording,flush-events,wait-for-rrweb}.js` | 14 tool classes l.177-790 | MIT; rrweb MIT (verify) | `browser-use>=0.8.0` (Python) |
| O7 | same | `openhands-sdk/openhands/sdk/hooks/{types,config,executor}.py` | `HookEventType` types.py l.9-17; host `subprocess.Popen(shell=True)` executor.py l.519-521 | MIT | — (reference only) |
| Ref | `OpenHands/OpenHands` @ `c26bda84cdc998eeeb99f5052c6aff666fe4aada` | `electron/main.mjs` l.358-401; `src/components/features/diff-viewer/*` | — | MIT © 2025 | — |
| Ref | `OpenHands/sandbox-server` @ `43e91604ccd0a9960c8d5c52faadd60b30f10e63` | `openhands/app_server/sandbox/{docker,process,kubernetes}_sandbox_service.py` | — | MIT outside `enterprise/` (absent at SHA) | — |
| Ref | `OpenHands/automation` @ `f5678e7fea09f826d16543d1e909c6e448b5111c` | `openhands/automation/*` | — | MIT | FastAPI, Postgres (no M0/M1 use) |
| Ref | software-agent-sdk @ same | `openhands-workspace/openhands/workspace/docker/workspace.py` l.214-255 (no cap-drop/network-none/limits) | — | MIT | — |

**Attribution obligation for any copied code or test vectors:** keep the MIT notice ("Copyright (c) 2026 OpenHands contributors" + permission text) in a file header or a `THIRD_PARTY_NOTICES` entry, and record repo + SHA + path in the commit message and an IMPL-ADR row.

## 3. Helix destination mapping

| Key | Roadmap task (IDs) | Existing Helix files | Destination (proposed) | Contracts to preserve | Must NOT be replaced |
|---|---|---|---|---|---|
| O1 | R1.30 (F-GIT-5, SEC-7, FR-29); R1.36 (SEC-8, F-REV-3) | `packages/engine/src/policy/policy.ts` (`classify`, `DESTRUCTIVE` l.18-25, `evaluate`), `policy/depgate.ts` (`segments` l.32, `parseInstalls` l.104), `index/treesitter.ts` (grammar loader) | new `packages/engine/src/policy/shell-ast.ts`; edits in `policy.ts`, `depgate.ts`; tests `packages/engine/test/git-safeguards.test.ts` (new, per R1.30 Accept), extend `test/depgate.test.ts` | `Verdict`/`ActionClass` types, `evaluate()` order (hard-deny before profile, IMPL-ADR-022), audit `rule_id` (R0.5) | policy engine, approval queue, depgate OSV flow |
| O2 | R1.17 (F-AGT-4, F-AGT-3) | `agent/runtime.ts` (step loop, retries), `verify/gates.ts` | new `packages/engine/src/agent/loop-detect.ts`; call site in runtime step loop; test `test/gates.test.ts` (per Accept) | transcript-derived state (IMPL-ADR-012), budgets, escalation order | runtime, checkpoints |
| O3 | none new; regression on existing redaction (SEC-6/F-OBS-3 stream path) | `util/redact.ts`, `sandbox/sandbox.ts:1056` | `util/redact.ts` (`StreamRedactor`), PTY/exec emit sites | `Redactor.redact` signature | sentinels (IMPL-ADR-031) |
| O4 | R1.19 (FR-13) | `tools/builtin.ts`, `util/diff.ts`, checkpoints (R0.6) | `packages/engine/src/changeset/patch-v4a.ts` (only if chosen) | changeset + per-hunk accept/reject model, checkpoint preimages | edit tools |
| O5 | R1.14 (F-CTX-3, FR-30) | `context/instructions.ts` (`INSTRUCTION_FILES` l.9) | same file | global→root→nested precedence, `context.explain` | instruction hierarchy |
| O6 | R1.23 (F-PRV-5, FR-23) | `preview/browser.ts`, snapshot refs (IMPL-ADR-029) | `preview/browser.ts` (+ optional rrweb asset) | ref addressing, `stale_ref` error, read-class policy | CDP stack |

## 4. Implementation packets (ready to execute after approval)

### P-O1 Shell AST rails → R1.30 / R1.36
1. Revalidate: `git -C <sdk> fetch --depth=1 origin 2cca5ba058bef0fcafb553b0bbcbf5f3ffc84a53`; read only the O1 files/line ranges above.
2. Create `policy/shell-ast.ts`: load Bash grammar via the existing loader in `index/treesitter.ts`; export `parseShell(cmd) → {segments: Cmd[], uncertain: boolean}` where `Cmd = {argv, wrappers, pipelineRole, redirects}`; resolve wrappers (`sudo`, `env`, `nice`, `xargs`, `bash -c/sh -c` recursive, depth cap like `_MAX_NESTING_DEPTH`).
3. Rules (Helix-native names, map to `rule_id`): `git.force_push` (`-f`, `--force*`, `+refspec`), `git.push_protected`, `git.reset_hard`, `git.remote_delete` (`push --delete`, `:branch`), `git.history_rewrite` (`rebase -i`, `filter-branch`, `commit --amend` on pushed), `fs.catastrophic_delete`, `net.fetch_to_exec`. Unparseable/uncertain → `ask` (never `allow`).
4. `policy.ts::classify` uses `parseShell` for `run_shell`/PTY input; keep regex table as fallback only if parse fails (fail toward `ask`).
5. `depgate.ts`: replace `segments()` regex split with `parseShell` segments; keep `parseInstalls` token logic.
6. Tests: R1.30 Accept `node --test test/git-safeguards.test.ts`; port upstream vectors from `test_policy_rails.py`/`test_shell_semantics.py` relevant to git/delete/fetch-exec as TS cases; extend `test/depgate.test.ts` with chained/wrapped installs (`sudo env X=1 npm i foo && pip install bar`).
7. Run via `node scripts/quiet.mjs "..."` + `npx tsc -p tsconfig.helix.json`.
- Expected: Accept output per roadmap; no existing policy test regresses.
- Risks: grammar edge cases → `ask` storms (mitigate: measure ask rate on existing test corpus); performance (cache parse per command).
- Rollback: revert the commit; `classify` regex path is unchanged underneath.

### P-O2 Loop detector → R1.17
1. Revalidate O2 file at SHA; port predicates as pure `detectLoop(messages, cfg) → {kind, sinceIndex} | null` over Helix transcript (same tool+args+result ×N, same error ×N, assistant monologue ×N, A/B alternation ×N, repeated context-overflow).
2. Runtime: on detection publish `agent.loop_detected` (audit), then follow existing F-AGT-3 ladder (structured diagnostic → model escalation → ask human). No new retry policy.
3. Tests inside `test/gates.test.ts` (fake provider) for each predicate + bounds.
- Risk: false positives on legitimate polling; thresholds configurable. Rollback: remove call site.

### P-O3 Stream redaction (Q2: parked on PR #23; investigate in isolation first)
1. Investigation only, outside Helix product code and PR #23: write an isolated reproduction test (separate scratch location, not committed to PR #23) that registers a secret and feeds PTY `onData` / exec output as two chunks splitting it; check whether the UI-bound stream ever contains the value.
2. If NOT reproducible: mark O3 Rejected and record the evidence here.
3. If reproducible: report the evidence and propose a narrowly scoped security fix (candidate: `StreamRedactor` holding back `maxLen-1` chars, flush on close, in `util/redact.ts`, used at `sandbox.ts:1056` and exec emitters) **for user approval. Do not apply any fix without approval.** A fix must follow AGENTS.md (one-line `docs/decisions.md` bug row).

### P-O4 V4A patch parser — **NOT APPROVED (Q3). Do not implement.**
Kept only as a record of what was evaluated. The user declined adding an OpenAI-style `apply_patch` tool; R1.19 keeps Helix's native atomic changeset design (changeset ops + per-hunk accept/reject + checkpoint preimages per R0.6). Do not reopen without a new explicit user decision.

### P-O5 / P-O6 (idea-level only)
- R1.14: add `CLAUDE.md`, `GEMINI.md` (case-insensitive) and native `.cursor/rules/*.mdc` front-matter (`description`, `globs`, `alwaysApply`) — upstream has no `.mdc` code to reuse.
- R1.23: keep CDP + refs; build action-log record/replay natively; rrweb only as optional visual trace (new dependency → approval).

## 5. Decision register

| Key | Status | Note |
|---|---|---|
| O1 Shell AST rails | **Approved as design input (Q1)** | R1.30/R1.36; fail toward `ask`; no new dependency; implementation not started |
| O2 Loop detector | **Approved as design input (Q1)** | R1.17; must support minimal-diff retries; implementation not started |
| O3 Stream masking | **Approved for isolated investigation only (Q2)** | Parked on PR #23; report evidence, propose fix for approval |
| O4 V4A parser | **Rejected by user (Q3)** | Native atomic changeset retained |
| O5 Instruction discovery | Recommended (idea only) | — |
| O6 Browser/rrweb | Needs further investigation | rrweb = new dep |
| O7 Hooks | Already implemented adequately in Helix | Upstream runs hooks on host |
| O8 Condenser | Already implemented adequately in Helix | — |
| O9 Agent loop/SDK | Rejected | Second orchestrator |
| O10 Sandbox/workspaces | Already implemented adequately in Helix | Upstream weaker |
| O11 MCP (OpenHands) | Rejected | Python/fastmcp; consider official TS SDK separately |
| O12 Secrets | Already implemented adequately in Helix | + O3 |
| O13 Desktop UI | Already implemented adequately in Helix | — |
| O14 Benchmarks for HTS | **Audited (Q4); policy approved (Q5–Q7)** | Methodology reference only; no Python runtime; harness not implemented; no datasets downloaded |
| O15 CI (R0.8) | No action | Stays postponed |
| O16 Terminal | Already implemented adequately in Helix | — |
| O17 LLM/ledger | Rejected | litellm; Helix ledger stronger |

### Decision log (user decisions, all seven answered)

| Q | Decision | Status | Exact conditions |
|---|---|---|---|
| Q1 | O1 + O2 as design inputs for R1.30, R1.36, R1.17 | **APPROVED** | Adapt useful algorithms and test cases into Helix's existing TypeScript architecture. No second agent runtime. No unnecessary dependencies. Preserve all existing security policies. Uncertain shell parsing fails toward approval (`ask`), never allow. Loop detector must support minimal-diff retries (a slightly different retry must not be flagged as a loop; retries steered toward minimal diffs). Implementation happens on the Helix branch when the roadmap reaches those tasks; **not started**. |
| Q2 | O3 split-chunk secret leak | **KEEP PARKED on PR #23; investigation approved** | First investigate with an isolated reproduction test, without modifying Helix product code or PR #23. If reproducible: report evidence and propose a narrowly scoped security fix **for user approval**. Not yet investigated. |
| Q3 | OpenAI-style `apply_patch` tool in R1.19 | **NOT APPROVED** | Preserve Helix's native atomic changeset design. |
| Q4 | Bounded read-only audit of OpenHands/benchmarks for R1.39 | **APPROVED and COMPLETED** | Report: `docs/research/openhands/audit-benchmarks-r1-39.md` (repo @ `60b3548cea8b41276ac0d44ea36a01b82936bbe4`, MIT). Methodology reference only; no implementation. |
| Q5 | Public datasets as HTS seed material | **APPROVED** | Subject to licence and provenance verification. Do not restrict all 300 tasks to in-house authoring. Maintain a per-task licence manifest covering dataset, original repository, commit, task text, tests and any copied code. **Exclude unverified and `license:other` sources until individually reviewed.** |
| Q6 | Contamination policy | **APPROVED: HYBRID** | Three categories: (1) public benchmark-derived tasks, marked potentially contaminated; (2) post-training-cutoff repo commits when a model's cutoff is known and verifiable; (3) private Helix-authored tasks and synthetic mutations with hidden tests. Post-cutoff does not guarantee zero contamination. Keep a separate high-confidence held-out set for evaluating actual Helix performance. Record task provenance, commit date, task creation date, source category and contamination classification. Public benchmark tasks must not be the sole evidence of Helix performance. |
| Q7 | Task environment strategy | **APPROVED: SHARED BASE IMAGES** | Lightweight immutable base images grouped by language/toolchain; reuse cached repo-specific dependency layers where practical; fresh disposable workspace/container per task attempt; the agent never receives hidden grader tests; grader runs in a separate clean environment; custom images only for genuine environment needs that cannot fit the shared base. |

Standing constraints from the user: no datasets downloaded yet; HTS harness not implemented; no changes to product code, plan, architecture, roadmap, checkboxes or PR #23 from this branch.

Approved as design input: **O1, O2** (not started). Approved for isolated investigation: **O3**. Rejected: **O4**. No code implementation is approved.

## 6. Session handoff

- **Session 1 (2026-11-12) completed:** Helix governance docs (AGENTS.md, decisions.md, roadmap M0/M1 task list + key Accept lines, progress dashboard); Helix source spot-checks (`policy/policy.ts`, `policy/depgate.ts`, `context/instructions.ts`, `context/compaction.ts`, `agent/runtime.ts` hooks l.1226-1253, `util/redact.ts`, `sandbox/sandbox.ts:1056`, `index/treesitter.ts`); OpenHands at the SHAs in §2: repo topology/licences, SDK modules (hooks, skills, condenser, security, stuck detector, secret registry, critic list), tools (browser_use, file_editor, apply_patch, terminal sizes), docker workspace flags, sandbox-server sandbox services list, Agent Canvas Electron flags/features.
- **Session 2 (2026-11-12) completed:** benchmarks audit (OpenHands/benchmarks @ `60b3548cea8b41276ac0d44ea36a01b82936bbe4`): repo structure, benchmark list, infer/score separation and hidden-test method, licence metadata check, reuse/effort table (`audit-benchmarks-r1-39.md`). Recorded decisions Q1–Q7 in all three research docs.
- **Not yet investigated:** O3 isolated reproduction (Q2); `critic/` internals (LLM-based, likely reject for R1.17); `delegate`/`subagent` vs R1.47; `file_editor` provenance; MCP OAuth (`mcp/oauth.py`) vs later M4; rrweb licence/version; Harbor internals; individual upstream repo licences and the Multi-SWE-bench dataset card text; actual per-language task counts (no datasets downloaded).
- **Next steps (all user-gated, in roadmap order):** (a) when asked, run the O3 isolated reproduction and report evidence; (b) execute P-O2 at R1.17 and P-O1 at R1.30/R1.36 on the Helix branch when the roadmap reaches them (current next task per dashboard: R1.8b; R1.11 has WIP on PR #23); (c) when R1.39 is reached, design the HTS task schema, per-task licence manifest and `validate.mjs` natively under the Q5–Q7 policy.
- **Still needs user approval:** any O3 fix; any new dependency (rrweb, MCP TS SDK); any dataset download; any HTS harness implementation; each source dataset's licence review.
