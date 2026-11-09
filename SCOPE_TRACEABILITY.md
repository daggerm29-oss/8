# Helix — Scope Traceability Audit

**Baseline (authoritative):** `plan.md` and `architecture.md` at commit `f4742348efe912d2188dbc28a260aca32d391577`.
**Compared against:** `main` at `1412acb` (PR #18 merged: M0–M2), plus open draft PR #19 (M3 DAG + leases, base `main`, not merged).
**Audit date:** 2026-11-09 (revision 2: re-checked against code; see §0). **Not modified:** `plan.md`, `architecture.md`, `docs/roadmap.md`, `progress.md`.

## 0. Revision 2 corrections

A second pass re-read the baseline, re-ran the full engine suite (`node --test --test-concurrency=1 "test/**/*.test.ts"` → **114/114 pass, 0 fail**, exit 0), and checked each claim in revision 1 against the source. Changes:

| ID | Rev 1 | Rev 2 | Reason (evidence) |
|---|---|---|---|
| F-MDL-1 | FV | **RED** | The original AC requires conformance for streaming, tool round-trip, **structured output**, cancellation, and **rate-limit retry**. `providers/conformance/test/conformance.test.ts` covers streaming, tool round-trip, error normalization, abort, and cross-provider transcripts. It has no structured-output case, and the IR/adapters expose no structured-output (response schema) option. |
| F-CTX-3 | NV | **RED** | `context/instructions.ts` loads only `AGENTS.md` and `HELIX.md` (global, root, nested). The **`CLAUDE.md` / `.cursor/rules` import** required by F-CTX-3 and FR-30 does not exist. |
| F-MDL-2 | RED | RED (gap widened) | The message IR (`protocol/src/models.ts:29`) has only `text` parts, so **image input for screenshots (AC 3) is impossible**. Screenshots reach the model as a text path only (IMPL-ADR-021). |
| FR-25, F-MCP-1 | RED | RED (gap widened) | `mcp/client.ts:8` negotiates `MCP_PROTOCOL_VERSION = '2025-06-18'`, not the **2026-07-28** revision required by FR-25. Extension negotiation is still absent. |
| SEC-13 | RED | RED (detail) | A CSP exists (`engine.ts:499`), but it sets `frame-ancestors *` and `style-src 'unsafe-inline'`, which is not "strict". The preload exposes a frozen static object and no IPC channels, so the IPC allowlist is vacuous rather than validated. |
| F-SBX-5, SEC-12 | — | confirmed | The legacy tracker claims "reaper on engine start". No reaper or orphan sweep exists in `sandbox/` or `engine.ts`, so classification is unchanged. |
| F-ORC-4 | — | confirmed | The legacy tracker claims batch approve/deny in the Monitor view. `engine/ui/app.js` has per-approval buttons only, so classification is unchanged. |
| FR-34 | — | confirmed | `apps/cli/src/main.ts` subcommands: tasks, resume, ledger, checkpoints, restore, plan, search, symbols, impact, mcp. No `helix run`. |

Net effect: FV 14 → 13, RED 71 → 73, NV 13 → 12. Counts in §2.1 are updated.

Baseline integrity: `architecture.md` on `main` is byte-identical to the baseline. `plan.md` on `main` differs by one added line (line 6): *"the checklist in docs/roadmap.md overrides §11, §12 and §19 for what to build"*. That line is the mechanism by which scope was reduced without changing the spec text. This audit ignores it and uses the original text.

---

## 1. Method and classification

| Code | Classification | Rule applied |
|---|---|---|
| **FV** | Fully implemented and independently verified | All behavior in the original requirement exists **and** an automated test or eval in this repo checks the original acceptance criterion (AC). Tests were re-run independently in revision 2: full engine suite 114/114 pass on `main` (`1412acb`). Passing tests prove only what they assert; most assert a reduced AC. |
| **RED** | Implemented in reduced form | Code exists, but it is narrower than the original requirement (fewer languages, backends, checks, or scopes). The reduction is listed. |
| **NV** | Implemented but not independently verified | Code appears to cover the requirement, but no test checks the original AC (often "legacy" roadmap evidence or a metric that was never measured). |
| **DEF(Mx)** | Deferred, with milestone | Not on `main`; a current roadmap item covers it in milestone Mx. |
| **MISS** | Missing from the current roadmap | Not implemented, and no roadmap item (counted or launch gate) covers it. **These are silent scope cuts.** |
| **REJ** | Explicitly rejected by the original spec | The baseline itself says not to build it. |
| **NI** | Not implemented | Not implemented; the roadmap mentions it only as an uncounted human launch gate or a sub-bullet, so it does not drive the progress percentages. |

"Independently verified" here means verified by a repeatable automated check of the **original** AC. No requirement has been verified by a party outside the build sessions, and no live benchmark at the original thresholds has been run except the M0/M1 live evals noted below.

Evidence shorthand: paths are relative to `packages/engine/src/` unless prefixed. "Legacy" means the roadmap item's evidence line is `legacy, built in sessions 1–16 before evidence rule`, so the roadmap provides no proof.

---

## 2. Summary of scope reductions

### 2.1 Counts (154 numbered requirements; every ID in the baseline is covered)

| Group | Total | FV | RED | NV | DEF | MISS | NI |
|---|---|---|---|---|---|---|---|
| FR-1…38 | 38 | 7 | 19 | 1 | 7 | 4 | 0 |
| F-* (76 features) | 76 | 5 | 44 | 8 | 13 | 5 | 1 |
| NFR-1…13 | 13 | 0 | 3 | 2 | 1 | 5 | 2 |
| SEC-1…14 | 14 | 1 | 7 | 1 | 1 | 3 | 1 |
| PERF-1…13 | 13 | 0 | 0 | 0 | 0 | 0 | 13 |
| **Total** | **154** | **13 (8%)** | **73 (47%)** | **12 (8%)** | **22 (14%)** | **17 (11%)** | **17 (11%)** |

Only 8% of numbered requirements meet the strict FV bar. 47% are implemented in reduced form. 11% have been dropped from the roadmap without a replacement item, and another 11% (all PERF budgets, plus NFR-1, NFR-5, SEC-12, F-TEAM-3) are not implemented and are not driven by any counted roadmap item. No REJ appears among numbered IDs; the three rejected items are X19–X21 (§5).

### 2.2 Most significant reductions (ranked by impact)

1. **No Monaco editor or real IDE.** Original M1 required an Electron workbench with a Monaco editor, dockable layout, and command palette (FR-33, F-UI-1, plan §1.4 and §12 M1). `main` has a no-build HTML workbench (`engine/ui/`) wrapped in a minimal Electron shell (`packages/desktop/main.cjs`). No editor, palette, layouts, Problems panel, MCP manager, or Intelligence Explorer exists, and **no roadmap item schedules them**. PERF-1 and PERF-2 cannot be measured.
2. **Whole-toolchain containment is overstated.** F-SBX-2 is ticked in M1, but MCP stdio servers are spawned directly on the host (`mcp/client.ts:54` `spawn(...)`) and headless Chrome is spawned on the host (`preview/browser.ts:263`). The original AC ("cannot read host home from *any* tool") is therefore not met. SEC-5 (MCP server per sandbox) is not implemented.
3. **Silent unsandboxed fallback.** When `unshare` is unavailable, `LocalSandbox` falls back to `local-process` (`sandbox/sandbox.ts:163`) with no isolation and no permanent UI indicator. That contradicts SEC-1.
4. **"Semantic" vector search is lexical hashing.** F-IDX-6 is ticked, but the embedder is `helix-local-hash-v1` (feature hashing of identifier words and trigrams, `index/embed.ts`). It is not a neural or semantic model, and provider embeddings (`gemini-embedding-2`) are not wired in.
5. **SCIP/LSP precise references reduced to TypeScript only.** F-IDX-2 uses the TypeScript LanguageService for depth-1 callers (`index/precise.ts`). No SCIP ingestion, no pyright/gopls/rust-analyzer/jdtls, no confidence-per-edge across the graph. The AC (precision ≥ 0.95 for TS/Python/Go/Rust) is unmeasured.
6. **Browser automation largely absent.** F-PRV-5 and FR-23 require navigate/click/fill/select/press/scroll/hover/wait_for/assert/eval/record/replay. `main` has only `preview_screenshot`, `preview_console`, and `preview_snapshot`. No interaction tools are on the roadmap. M1 item T4 is labeled "minimal" with no follow-up.
7. **Review and security agents are missing.** F-REV-1 (review agent) and F-REV-2 (SAST, secret scan, IaC) are not implemented. The only related roadmap item is the M4 "PR review bot". Local review (FR-36 "M2 local") and SAST are not on the roadmap.
8. **Element-to-source is a minimal heuristic.** F-VIS-1 requires compiler plugins (Babel/SWC/Vite/esbuild) and React fiber `_debugSource`, with ≥ 95% on React/Vue/Svelte fixtures. `main` relies on a pre-existing `data-helix-loc` attribute or a text match (`preview/locate.ts`). The 24/24 result is a synthetic fixture where 6 cases do not check the line (`docs/decisions.md`).
9. **Performance requirements have no harness.** None of the 13 PERF budgets is measured anywhere in `evals/` or tests. They appear only inside the uncounted M1 launch gate ("original M1 exit criteria").
10. **Git integration reduced.** FR-28 requires branch, worktree, rebase-assist, and PR creation. `main` has status/diff/stage-all/commit (`workspace/git.ts`). No per-hunk staging, no stash, no PR creation (F-GIT-4 is not on the roadmap; the M4 review bot is a different feature). No secret scan before commit (SEC-7, F-GIT-5).
11. **Atomic changesets with per-hunk accept/reject (FR-13) are missing**, as are rename and delete file tools. Not on the roadmap.
12. **Budgets cover task and day only.** FR-32 requires task, session, day, and org (`models/ledger.ts:27` `scope: 'task' | 'day'`). The roadmap item is ticked.
13. **Sandbox backends reduced.** F-SBX-1 requires local-container (Podman/Docker + gVisor), local-os light mode (Seatbelt/bubblewrap), cloud microVM, and cloud provider. `main` has `unshare` + chroot, an unisolated process fallback, and WSL. No container backend is scheduled (original M0 scope). The roadmap has cloud only (M3). No cgroup limits (ISSUE-005), suspend/resume, snapshots, or reaper (F-SBX-5, SEC-12).
14. **Multi-agent orchestration is not on `main`.** F-ORC-2/3 work exists only in draft PR #19, which has two known review issues (shared-mode lease bypass, worktree lease leak). Built-in subagent types `browser-verify`, `test-runner`, `reviewer`, and `researcher` (F-ORC-1) are not scheduled by name.
15. **MCP spec features missing.** Extension negotiation (Tasks, Skills over MCP, MCP Apps; 2026-07-28 spec) for FR-25 and F-MCP-1 is not implemented or scheduled. Trust tiers are 2 (`trusted`/`untrusted`), not the 4 specified (F-MCP-3). No version or hash pinning (SEC-5).
16. **Non-functional areas dropped.** Scalability (NFR-2), accessibility WCAG 2.2 AA (NFR-9), maintainability (NFR-11: lint boundaries, ≥ 80% coverage), i18n (NFR-12), cost overhead (NFR-13), and supply chain (SEC-14) have no roadmap items.

### 2.3 Roadmap items whose tick overstates the original requirement

| Roadmap item (ticked) | Original | Gap |
|---|---|---|
| M1 "Whole-toolchain containment (F-SBX-2)" | All tools contained | MCP stdio + Chrome on host |
| M1 "Sandbox lifecycle + resources (F-SBX-5)" | CPU/mem/PID/disk limits, snapshot, suspend, reaper | Only wall-time and output limits |
| M1 "Symbol index, heuristic (F-IDX-1)" | tree-sitter top 20 languages, watcher, BLAKE3/Merkle | 6 tree-sitter languages (M2), no watcher (ISSUE-007), SHA-256 |
| M1 "Budgets (F-TOK-2)" | task/session/day/org | task/day |
| M1 "Web workbench (F-UI-1/2)" | Dockable IDE incl. Monaco | Tabbed HTML page |
| M1 "Diagnostic parsers (F-TRM-2)" | tsc, eslint, pytest, jest/vitest, go, cargo, mypy, bundlers, docker | tsc, node:test, pytest, eslint, go, generic |
| M2 "Precise references via SCIP/LSP (F-IDX-2)" | SCIP + LSPs for 4+ languages | TS LanguageService only |
| M2 "Local-first vector embeddings (F-IDX-6)" | Semantic embeddings | Lexical feature hashing |
| M2 "OSV dependency gate (F-REV-3)" | OSV + license + typosquat + install scripts + age | OSV only, agent shell installs only |
| M2 "Windows support (NFR-6)" | Windows 11 native + WSL2 | Linux shims only; WSL has no egress proxy or fs isolation |
| M2 "M2 eval" | O3 ≥ −40% cost, O5 ≥ 0.70, element→source ≥ 95% | Fake provider; O5 not measured; synthetic e2s fixture |

---

## 3. Requirement-by-requirement audit

Columns: **ID** · **Original requirement (baseline)** · **Arch §** · **Current implementation evidence (`main`)** · **Roadmap ref** · **Class** · **Missing functionality**

### 3.1 Functional requirements (plan §6)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| FR-1 | Gemini via API key; model listing, selection, per-request config (temperature, thinking, max output) | §7.3 | `packages/providers/gemini/src/index.ts` (temperature/thinking), manifest, `models.list`; conformance suite | M0 "Gemini adapter" | FV | Live listing only partially exercised (fake server in tests) |
| FR-2 | OpenAI via API key and Sign in with ChatGPT (flagged) | §7.4 | `packages/providers/openai/src/index.ts` API key only | M0 "OpenAI adapter, API-key mode"; SIWC = M2 human launch gate | RED | SIWC/OIDC+PKCE not implemented |
| FR-3 | Per-role models: planner, coder, explorer, reviewer, debugger, summarizer, embedder, completion | §7.5 | `models/ledger.ts:6` ModelRole (all 8 + router); `models/roles.ts`; `test/roles.test.ts` | M1 "Role-based models + fallback" | FV | — |
| FR-4 | Auto-route by task class, capability, cost, latency; fallback on failure | §7.6 | `models/router.ts` (step type → tier), breaker in `models/gateway.ts`; `test/router.test.ts` | M2 "Model router v1" | RED | No capability, context-size, cost, or latency features in routing |
| FR-5 | New providers via adapter, no core change | §7 | `@helix/protocol` ProviderAdapter; `packages/providers/*`; conformance suite | M0 "Provider adapter framework" | FV | — |
| FR-6 | OS keychain (desktop) or KMS vault (cloud); never plaintext | §8 | `vault/keychain.ts` (macOS `security`, libsecret, Windows Credential Manager via PowerShell); `test/keychain.test.ts` (shims) | M2 "Electron desktop shell + OS keychain" | RED | KMS (cloud) not built; keychains tested only via Linux shims |
| FR-7 | OAuth code + PKCE, loopback, refresh rotation | §8 | None | M4 "OAuth broker (F-AUTH-2)" | DEF(M4) | Entire OAuth flow |
| FR-8 | Incremental index: symbols, refs, imports/exports, call edges, tests, routes, schemas, configs, docs | §11, §12 | `index/index.ts`, `index/treesitter.ts`, `index/graph.ts`, `index/domain.ts` | M1 "Symbol index", M2 tree-sitter, domain extractors | RED | No docs indexing, no file watcher (ISSUE-007), heuristic call edges |
| FR-9 | Exact, BM25, semantic vector, structural AST pattern, graph queries | §11.6 | `search` (exact), FTS5 BM25, hash-vector retriever, `impact` | M1 "Hybrid retrieval", M2 vectors | RED | No structural (AST pattern) query; no general `graph.query`; vector is not semantic |
| FR-10 | Impact queries without LLM | §11.5 | `impact` tool, `index/graph.ts`; `test/graph.test.ts`, `test/plan-impact.test.ts` | M2 "Code graph v0 + impact", "Impact Report" | FV | Precision limited by heuristic graph outside TS |
| FR-11 | Respect `.gitignore`, `.helixignore`, secret patterns; never embed secrets | §11.1 | `.gitignore` + secret files skipped in `index/index.ts`; `.env` not embedded (`test/vectors.test.ts`) | M1 index | RED | `.helixignore` not supported |
| FR-12 | Plan → act → verify; Plan Mode with user-editable plan | §9.4 | `PLAN_TOOLS` + `submit_plan` in `agent/runtime.ts:101` | M1 "Plan Mode" | RED | No plan edit/approve API before execution found |
| FR-13 | Create/edit/rename/delete as atomic changesets, per-hunk accept/reject | §9 | `write_file`, `edit_file`; diff view; checkpoint restore | None | MISS | Rename/delete tools, atomic changeset, per-hunk accept/reject |
| FR-14 | Run commands in sandbox, stream output, parse diagnostics | §19 | `run_shell`, live output chunks (`sandbox/sandbox.ts:36`), `diagnostics/parsers.ts` | M0 tools, M1 parsers | FV | — |
| FR-15 | Subagents with isolated context and restricted tools (M1 Explore, M3 general) | §10 | `explore` tool; `test/explore.test.ts`. General: PR #19 only | M1 T6; M3 "General subagents + DAG" | DEF(M3) | General subagents not on `main` |
| FR-16 | Leases; worktrees for parallel agents | §10.4 | PR #19 only (`dag/lease.ts`), known bypass + leak | M3 "Write leases + worktrees" | DEF(M3) | Not on `main`; two open defects |
| FR-17 | Every step checkpointed and reversible | §20.3 | Checkpoints in blob store, `restore()` `agent/runtime.ts:621` | M1 "Shadow checkpoints" | RED | Not a shadow git object store (see F-GIT-2) |
| FR-18 | Approval per action class: write, command, network domain, MCP tool, git push, deploy | §10.5 | `policy/policy.ts` classes read/write/exec/network/destructive; `tool:<name>` preapproval | M1 "Human approvals" | RED | No per-domain network approval class, no deploy class; push is hard-denied rather than approvable |
| FR-19 | All agent processes sandboxed, deny-by-default network and credentials | §16 | `LocalSandbox` + egress proxy | M1 F-SBX-2, T1 | RED | MCP servers and Chrome run on host; unisolated `local-process` fallback |
| FR-20 | Detect/start dev servers (framework detection), expose ports, HMR | §17.2 | `preview/devserver.ts` (package.json `dev`/`start`); `test/devserver.test.ts` | M1 T2 | RED | Framework detection limited; no HMR passthrough verification; no persisted recipe |
| FR-21 | Multiple preview tabs and browser sessions, viewport presets, device emulation | §17 | Single preview iframe (M1 T3 "One tab only") | None | MISS | Multi-tab, sessions, presets, emulation |
| FR-22 | Console, uncaught errors, failed requests, build errors as structured events | §18.3 | `preview/browser.ts` CDP console/exceptions/network; `test/snapshot.test.ts` | M2 "Runtime telemetry" | RED | Build errors / dev-overlay detection; source-mapped stacks |
| FR-23 | Agents navigate/click/type/select/scroll/assert by stable refs | §18.5 | Refs exist in snapshot; no interaction tools | None (T4 "minimal") | MISS | All interaction tools |
| FR-24 | Map rendered elements to source (M2) | §18.6 | `preview/locate.ts`; `test/element-source.test.ts` | M2 "Element→source" | RED | Compiler plugins, React owner stack, source maps |
| FR-25 | MCP stdio + Streamable HTTP, 2026-07-28 spec, extension negotiation | §14 | `mcp/client.ts`, `mcp/http.ts`; `test/mcp*.test.ts` | M1 "MCP client stdio/HTTP" | RED | Spec revision: negotiates `2025-06-18`, not 2026-07-28 (`mcp/client.ts:8`); extension negotiation (Tasks, Skills over MCP, MCP Apps) |
| FR-26 | Tool search; only relevant schemas in context (M2) | §14.4 | `mcp/manager.ts` search; M2 eval 240 tokens/turn at 200 tools | M2 "MCP tool search" | FV | Success-rate regression (≤ 2 pp) not measured |
| FR-27 | Per-server permission scope, credential scope, process sandbox | §14.6 | Trust flag per server; no sandboxing | M1 "MCP permissions" | RED | Process sandbox and credential scope per server |
| FR-28 | Status, diff, stage, commit, branch, worktree, rebase-assist, PR creation | §20 | `workspace/git.ts` status/diff/stageAll/commit; `test/git.test.ts` | M1 T5; M3 worktrees | RED | Branch, rebase-assist, PR creation (unscheduled), hunk staging |
| FR-29 | Destructive git ops require approval | §20.6 | Force push / push to main hard-denied (`IMPL-ADR-022`); `test/git.test.ts` | M1 T5 | FV | Remote branch deletion and `reset --hard` not specifically tested |
| FR-30 | Load AGENTS.md/HELIX.md/CLAUDE.md/.cursor/rules; typed memory with review | §13.5–13.6 | `context/instructions.ts` | M1 "Project instructions"; M3 "Fix-history / typed memory" | DEF(M3) | Typed memory (M3); `CLAUDE.md` / `.cursor/rules` import **not implemented** and not scheduled (only AGENTS.md/HELIX.md loaded) |
| FR-31 | Tokens (input/cached/output/reasoning) and cost per call by agent, task, tool, provider, model | §29 | `models/ledger.ts` | M0 "Ledger v0" | NV | Attribution to tool/agent and ±1% reconciliation not re-verified (legacy evidence) |
| FR-32 | Budgets per task, session, day, org; soft and hard | §29.6 | `ledger.ts:27` `'task' \| 'day'` | M1 "Budgets" | RED | Session and org scopes |
| FR-33 | Desktop: explorer, editor, agent panel, terminal, preview, problems, task monitor, SCM, intelligence explorer, MCP manager, model settings; dockable; command palette | §5 | `engine/ui/index.html` tabs: activity, transcript, steps, diff, files, gates, artifacts, impact, preview, git, roles, terminal | M1 "Web workbench" | RED | Monaco editor, Problems, Intelligence Explorer, MCP manager, docking, palette |
| FR-34 | CLI exposes engine headless/CI (`helix run`, `helix -p`) | §4 | `apps/cli/src/main.ts`; `apps/cli/test/cli.test.ts` | M0 "CLI helix -p" | RED | `helix run` subcommand not found |
| FR-35 | Generate/run tests for changed code (M2); E2E from recordings (M3) | §9.6, §18.5 | `verify/testgen.ts` `propose_test`; `test/testgen.test.ts` | M2 "Test generation"; M3 "E2E tests from recordings" | DEF(M3) | E2E from recordings |
| FR-36 | Automated review of diffs with impact (M2 local, M4 PR bot) | §10.2 | None | M4 "PR review bot" only | MISS | Local review agent (M2 scope) not scheduled |
| FR-37 | Deploy adapters with approval + pre-deploy checks (M4) | §22.6 | None | M4 "Deploy adapters" | DEF(M4) | All |
| FR-38 | Team policies, MCP allowlists, memory, skills, RBAC, audit (M4) | §25.8 | Org-policy layer for models only (`models/roles.ts`) | M4 control plane, shared memory | DEF(M4) | All team features |

### 3.2 Feature specifications (plan §8)

#### Models (MDL) and Auth (AUTH)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-MDL-1 | Adapter framework + capability manifest + conformance (stream, tools, structured, cancel, retry) | §7 | `packages/providers/conformance`; `conformance.test.ts` (stream, tool round-trip, error normalization, abort, cross-provider transcript) | M0 | RED | Structured output (no API, no conformance case); rate-limit *retry* is in the gateway, not in the conformance suite |
| F-MDL-2 | Gemini: keychain key, live models + fallback manifest, multimodal, explicit caching, cache-hit in ledger, hide deprecated | §7.3 | Adapter + manifest; cached tokens in ledger | M0 | RED | Multimodal input (IR has text parts only, `protocol/src/models.ts:29`); explicit context caching (`cachedContents`); key validation on entry; deprecated-model hiding |
| F-MDL-3 | OpenAI API key + SIWC (flagged); never read other apps' credentials | §7.4, §8 | API key adapter; `vault/vault.ts:15` denylists `.codex` etc. | M0; SIWC = M2 launch gate | RED | SIWC |
| F-MDL-4 | Roles; org > user > workspace > task; fallback chain; role on every ledger row | §7.5 | `models/roles.ts`; `test/roles.test.ts` | M1 | FV | — |
| F-MDL-5 | Rule-based router (step type, capabilities, context size, file count, failures, budget), escalation, breaker; AC ≥ 30% cost cut with ≤ 3 pp drop | §7.6 | `models/router.ts`; `test/router.test.ts`; `evals/m2-eval.ts` | M2 | RED | Only step type + failures; AC measured with fake provider, success drop not measured; learned priors M4 |
| F-AUTH-1 | Keychain (3 OSes) or KMS; secrets never in context/logs/sandboxes; fuzzed scanner AC | §8, §25 | `vault/keychain.ts`, `util/redact.ts` | M2 | NV | Fuzzed secret-scanner test absent; KMS; real-OS keychain runs |
| F-AUTH-2 | OAuth broker (PKCE, loopback, rotation, revocation) | §8 | None | M4 | DEF(M4) | All |
| F-AUTH-3 | SSO/SAML, SCIM, RBAC (M4) | §8.5 | None | M4 "SSO + SCIM" | DEF(M4) | All |

#### Codebase intelligence (IDX), Context (CTX)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-IDX-1 | tree-sitter top 20 languages; watcher; BLAKE3; Merkle; PERF-6/7 | §11, §12 | `index/treesitter.ts` (ts/tsx/js/py/go/rust/java); SHA-256 content hash | M1 heuristic; M2 tree-sitter swap | RED | 14 more languages, watcher, BLAKE3 (`IMPL-ADR-004`), Merkle, perf AC |
| F-IDX-2 | LSPs in sandbox + SCIP ingestion; edge confidence; precision ≥ 0.95 in TS/Py/Go/Rust | §11.4 | `index/precise.ts` TS LanguageService in sandbox; `test/precise.test.ts` | M2 | RED | SCIP, non-TS LSPs, per-edge confidence, precision benchmark |
| F-IDX-3 | Code graph (file, module, symbol, test, route, table, config, package, doc nodes; 10 edge types); `graph.query`; Impact Report ≤ 500 ms on 1M LOC | §11.5 | `index/graph.ts` name-based refs narrowed by imports (`IMPL-ADR-016`); `impact` | M2 "Code graph v0" | RED | Most node/edge types, `graph.query`, perf AC |
| F-IDX-4 | Exact, BM25, vector, fuzzy symbol, graph retrievers → RRF → rerank → dependency expansion → packing; Recall@10 ≥ 0.70 | §11.6 | `index/index.ts` RRF k=60 over BM25/vector/symbol/path | M1 | RED | Rerank, graph-neighborhood retriever, dependency expansion; Recall@10 (O5) unmeasured |
| F-IDX-5 | Routes (7 frameworks), DB schemas (5), env/config, docs, git history; shown in Intelligence Explorer | §11.7 | `index/domain.ts`; `test/domain.test.ts` | M2 | RED | Docs, git history (blame, co-change), Django/Rails/Spring, ActiveRecord; no Explorer UI |
| F-IDX-6 | AST-aligned chunks; provider or bundled local embedding model; lazy; cost in ledger | §12.3 | `index/embed.ts` feature hashing 512-dim | M2 | RED | Real semantic model, provider embeddings, lazy prioritization |
| F-CTX-1 | Budgeted typed context; stable prefix ≥ 90% | §13 | `context/assembler.ts` | M1 | NV | Prefix-stability metric not measured (legacy) |
| F-CTX-2 | Compaction to structured state; ≤ 2 pp success drop | §13.4 | `context/compaction.ts`; `test/compaction.test.ts` | M1 | NV | Long-horizon success benchmark absent |
| F-CTX-3 | AGENTS.md, HELIX.md, nested; import CLAUDE.md/.cursor/rules; documented order | §13.5 | `context/instructions.ts` (AGENTS.md, HELIX.md: global → root → nested) | M1 | RED | `CLAUDE.md` / `.cursor/rules` import not implemented |
| F-CTX-4 | Typed memory (fact, convention, decision, fix, preference, pitfall), provenance, staleness | §13.6 | None | M3 "Fix-history / typed project memory" | DEF(M3) | All |

#### Agent (AGT) and Orchestration (ORC)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-AGT-1 | Loop with spans, cost, checkpoint ID per tool call; cancel ≤ 1 s | §9 | `agent/runtime.ts`; restart resume; `test/agent.test.ts` | M0 | NV | Cancel ≤ 1 s not measured |
| F-AGT-2 | Plan Mode; no write tool callable (policy-enforced); user approves/edits plan | §9.4 | `PLAN_TOOLS`, `policy.ts` `plan` profile | M1 | RED | Plan editing/approval UI or API |
| F-AGT-3 | Structured diagnostics; N retries; escalate model; then ask human; minimal diff per retry | §9.5 | Gate retry loop + router escalation | M1, M2 router | NV | "Minimal diff per retry" not verified |
| F-AGT-4 | Inferred gates confirmed by user; done requires green or logged waiver | §9.6 | `verify/gates.ts`; `test/gates.test.ts` | M1 | RED | User waiver flow (no `waive` in code) |
| F-AGT-5 | Skills lazy; hooks (pre/post tool, pre-commit, session-start) with declared permissions | §9.7 | `agent/skills.ts`; `test/skills.test.ts` | M2 | RED | pre-commit and session-start hooks; declared-permission enforcement for hooks |
| F-ORC-1 | Subagents explore, browser-verify, test-runner, reviewer, researcher; 1.5k return budget | §10 | `explore` only | M1 T6; M3 "General subagents" | RED | 4 named subagent types; none scheduled by name |
| F-ORC-2 | DAG with write-sets; deterministic schedule; failure blocks dependents | §10.3 | PR #19 `dag/scheduler.ts` | M3 | DEF(M3) | Not on `main` |
| F-ORC-3 | Leases; worktrees; 3-way merge + reviewer; zero lost writes | §10.4 | PR #19 `dag/lease.ts` (known defects) | M3 | DEF(M3) | Not on `main`; defects open |
| F-ORC-4 | Approval queue auto/ask/deny + batch; engine-enforced | §10.5 | `policy/policy.ts`, approvals table; `test/mcp-safety.test.ts` | M1 | RED | Batch approval not found |
| F-ORC-5 | Background/scheduled agents (cron, git, webhook, issues); durable, idempotent | §10.6 | None | M3 workers, schedules | DEF(M3) | All |

#### Sandbox (SBX), Preview (PRV), Terminal (TRM)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-SBX-1 | local-container (Podman/Docker + gVisor), local-os (Seatbelt/bwrap), cloud microVM, cloud provider; one policy across backends | §16 | `sandbox/sandbox.ts` providers `local-unshare`/`local-process`/`wsl` | M0 "Local sandbox v0"; M3 cloud | RED | Containers, gVisor, Seatbelt, bwrap (container backend not scheduled); conformance across backends |
| F-SBX-2 | Shell, files, LSPs, dev servers, tests, MCP stdio, hooks, browser all in sandbox | §16.3 | Shell/LSP/dev server/hooks in sandbox; MCP (`mcp/client.ts:54`) and Chrome (`preview/browser.ts:263`) on host | M1 (ticked) | RED | MCP and browser containment; red-team suite (§15.5) |
| F-SBX-3 | Egress proxy, allowlists per workspace/tool, DNS pinned, one-click allow | §16.5 | `sandbox/egress.ts`; `test/egress.test.ts` (direct bypass fails, denials reported) | M1 T1 | FV | Per-tool allowlist |
| F-SBX-4 | Sentinels + TLS-terminating substitution, all tools incl. MCP; env/cat/memory-dump reveal sentinels only | §16.6 | `sandbox/egress.ts`, `sandbox/x509.ts`; `test/masking.test.ts` | M2 | RED | MCP path (MCP not sandboxed); memory-dump test; persisted bindings |
| F-SBX-5 | Lifecycle (hydrate, snapshot, suspend, resume); CPU/mem/PID/disk/time limits; reaper; warm ≤ 2 s | §16.4 | Wall-time + output-size limits only | M1 (ticked) | RED | cgroups (ISSUE-005), snapshot/suspend/resume, reaper, PERF-9 |
| F-PRV-1 | Framework + package manager detection; TCP health; persisted recipe; ≥ 90% on 25 frameworks | §17.2 | `preview/devserver.ts`; `test/devserver.test.ts` | M1 T2 | RED | Framework fixture set, persisted recipe |
| F-PRV-2 | Multi-tab, HMR, viewport presets, device + media emulation, route-suggesting URL bar | §17 | Single iframe + reload | M1 T3 ("One tab only") | RED | All extras; no roadmap follow-up |
| F-PRV-3 | CDP console, exceptions (source-mapped), network, perf marks, Web Vitals, dev-overlay; Problems ≤ 500 ms | §18.3 | `preview/browser.ts`; `test/snapshot.test.ts` | M2 | RED | Source maps, Web Vitals, perf marks, overlay detection, Problems panel |
| F-PRV-4 | Snapshot with refs, digest, errors, build status, pHash screenshot; ≤ 1,500 / 400 tokens; ≥ 50% token cut | §18.4, §29 | `PreviewBrowser.snapshot()`, `preview_snapshot`; `test/snapshot.test.ts` | M2 | RED | Build status, pHash, token-size AC, browser-task suite |
| F-PRV-5 | navigate, click, fill, select, press, scroll, hover, wait_for, assert, screenshot(region), eval, record/replay; stale refs error | §18.5 | `preview_screenshot`, `preview_console` | M1 T4 (minimal) | RED | All interaction tools; not scheduled |
| F-TRM-1 | PTY via xterm.js; separate agent/user terminals; history + exit codes indexed | §19 | `sandbox.ts:319` `pty()`; xterm served by engine | M1 | RED | History/exit-code indexing (parking lot) |
| F-TRM-2 | Parsers for tsc, eslint, pytest, jest/vitest, go, cargo, mypy, bundlers, docker; ≥ 95% parse | §19.4 | `diagnostics/parsers.ts`: tsc, nodeTest, pytest, eslint, go, generic | M1 | RED | jest/vitest, cargo, mypy, webpack/vite/next, docker; accuracy AC |

#### Git (GIT), MCP, Tokens (TOK)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-GIT-1 | Status, side-by-side/inline diff, stage hunks, commit with AI message, branches, stash | §20 | Git tab: status, diff, stage all, commit | M1 T5 | RED | Hunk staging, AI message, branches, stash |
| F-GIT-2 | Shadow git object store per step; restore ≤ 1 s for 1k files | §20.3 | Blob-store before-images + `restore()` | M1 | RED | Not a git object store; perf AC unmeasured |
| F-GIT-3 | Worktree manager per parallel agent | §20.4 | PR #19 only | M3 "Write leases + worktrees" | DEF(M3) | Not on `main` |
| F-GIT-4 | PR creation with summary, impact report, evidence (GitHub App) | §20.5 | None | None (M4 item is a *review* bot) | MISS | PR creation |
| F-GIT-5 | Deny/ask force-push, rewrite, protected branches, large deletions; secret scan before commit; agents and CLI | §20.6 | Hard deny of force/main push | M1 T5 | RED | Large-deletion guard, history-rewrite guard, pre-commit secret scan |
| F-MCP-1 | Scopes user/workspace/org; spawn in sandbox; health, backoff, idle shutdown; extension negotiation; conformance vs reference servers | §14 | `mcp/manager.ts`, `mcp/client.ts`, `mcp/http.ts` | M1 | RED | Sandbox spawn, org scope, 2026-07-28 spec revision (uses 2025-06-18), extension negotiation, reference-server conformance |
| F-MCP-2 | tool_search + core set; ≤ 3k tokens at 200 tools; ≤ 2 pp success drop | §14.4, §15 | `mcp/manager.ts` search; `evals/m2-eval.ts` → 240 tokens/turn | M2 | RED | BM25 + embeddings index (keyword scoring only); success-drop measurement |
| F-MCP-3 | Trust tiers verified / org-approved / user-added / untrusted | §14.6, §25 | `trust?: 'trusted' \| 'untrusted'` (`mcp/manager.ts:43`) | M1 | RED | Two of four tiers; network/credential scope per tier |
| F-MCP-4 | Normalize {status, summary, data_ref, truncated}; artifact store; projection; cache by version + TTL | §15.4 | Cache with TTL (`mcp/manager.ts:245`); normalization | M2 | NV | JSONPath projection and resource-version keys not verified |
| F-MCP-5 | Provenance blocks; no approvals from tool output; taint tracking | §25.6 | `wrapUntrusted`, taint in `runtime.ts:794`; `test/mcp-safety.test.ts` | M2 | FV | — |
| F-TOK-1 | Ledger per call (provider, model, role, agent, task, tool, tokens, cost, latency); dashboard + export; ±1% | §29 | `models/ledger.ts`, `ledger.query` RPC | M0 | RED | Dashboard UI and export not found |
| F-TOK-2 | Soft/hard per task, session, day, org; pause and ask | §29.6 | `ledger.ts` task/day; `BudgetExceededError` | M1 | RED | Session and org scopes |
| F-TOK-3 | Deterministic-first catalog enforced by tool design | §29.2 | Deterministic impact, domain, parsers, gates | None (implicit) | NV | No catalog or enforcement check |
| F-TOK-4 | Stable prefix; provider explicit caching; cache-hit ≥ 60% | §29.4 | Stable composed context (`IMPL-ADR-015`) | None | RED | Explicit provider caching; cache-hit metric. Not on roadmap |

#### Visual (VIS), Testing (TST), Review (REV), UI, Observability (OBS), Deploy, Team

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| F-VIS-1 | Compiler plugins inject `data-helix-loc`; React fiber `_debugSource`; source maps; ≥ 95% on React/Vue/Svelte | §18.6 | `preview/locate.ts` (reads existing attr or text match); `evals/m2-eval.ts` 24/24 synthetic | M2 | RED | Plugins, fiber, source maps, real-framework fixtures |
| F-VIS-2 | Select element/region + instruct; component chain, styles, source slice; verification snapshot | §18.6 | `preview.instruct` RPC; workbench Inspect mode | M2 | RED | Region select, automatic verification snapshot |
| F-VIS-3 | Visual regression: baselines, pHash + SSIM + DOM diff | §18.7 | None | M3 "Visual regression" | DEF(M3) | All |
| F-VIS-4 | UI consistency: design tokens vs theme, off-token flags | §18.7 | None | None | MISS | All |
| F-TST-1 | Graph maps changed symbols to covering tests (static + coverage) | §11.5 | `test/selection.test.ts` | M2 | RED | Coverage-derived mapping |
| F-TST-2 | Generate tests for changed/uncovered symbols, mutation smoke | §9.6 | `verify/testgen.ts`; `test/testgen.test.ts` | M2 | FV | Automatic targeting of uncovered symbols is agent-driven |
| F-TST-3 | Record interaction → Playwright test → acceptance criterion | §18.5 | None | M3 "E2E tests from recordings" | DEF(M3) | All |
| F-TST-4 | Failing test/script from issue or stack trace before fixing | §9.5 | None | M3 "Bug auto-repro" | DEF(M3) | All |
| F-REV-1 | Review agent with impact, evidence, checklists; line-anchored comments | §10.2 | None | M4 "PR review bot" (bot, not local agent) | MISS | Local review agent |
| F-REV-2 | SAST (Semgrep-compatible), secret scan, IaC; 0 LLM tokens w/o findings; baseline labeling; blocking | §25.10 | None | None | MISS | All |
| F-REV-3 | OSV, license, typosquat, install scripts, age; allow/ask/deny | §16.7 | `policy/depgate.ts`; `test/depgate.test.ts` | M2 | RED | License, typosquat, install-script, age checks; installs outside agent `run_shell` |
| F-UI-1 | Dockable panels, saved layouts, fuzzy command palette | §5 | Fixed tab layout | M1 "Web workbench" | RED | Docking, layouts, palette (unscheduled) |
| F-UI-2 | Live tree of agents/subagents/tools/budgets/leases/checkpoints; pause/resume/cancel/rollback | §5.4 | Activity + Steps tabs | M1 | RED | Tree view, leases, pause/resume (pause in parking lot) |
| F-UI-3 | Intelligence Explorer: dependency/call/architecture graphs, API/route/DB views | §5.5 | Impact tab only | None | MISS | All |
| F-UI-4 | Plans, walkthroughs, impact reports, evidence, review results as linkable artifacts | §5.6 | Artifacts tab; `artifacts/evidence.ts`; `test/evidence.test.ts` | M2 | RED | Walkthroughs, recordings, review results |
| F-OBS-1 | OTel spans for every step + tool call; local trace viewer; OTLP export | §26 | `obs/tracing.ts` (OTLP JSON, `IMPL-ADR-005`) | M0 | RED | Local trace viewer UI |
| F-OBS-2 | Record tool I/O for deterministic replay | §26.4 | `replay/bundle.ts`; `test/replay.test.ts` | M2 | FV | — |
| F-OBS-3 | Append-only hash-chained audit (approvals, policy, credentials, pushes) | §26.5 | `events/bus.ts:133` chain + verify | M0 | NV | Coverage of each event category not verified; export is M4 |
| F-DEP-1 | Vercel, Cloudflare, Fly, OCI deploy; gates; approval; rollback (M4) | §22.6 | None | M4 | DEF(M4) | All |
| F-TEAM-1 | Org policies: models, providers, MCP allowlists, sandbox, budgets, residency | §25.8 | Model/provider org policy only | M4 control plane | DEF(M4) | MCP, sandbox, budget, residency policies |
| F-TEAM-2 | Shared memory and skills with review/versioning | §13.6 | None | M4 "Shared memory and skills" | DEF(M4) | All |
| F-TEAM-3 | Cloud workspaces + local↔cloud handoff via git + session bundle | §28 | Session bundle exists (F-OBS-2) | None explicit | NI | Cloud workspaces and handoff; only partially implied by M3 cloud sandbox and M4 control plane |

### 3.3 Non-functional requirements (plan §7)

| ID | Original requirement | Arch § | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|---|
| NFR-1 | Performance per §17 | §17 | None | M1 launch gate only | NI | See PERF table |
| NFR-2 | 5M LOC / 200k files on 16 GB, sharded index, lazy vectors | §11 | Single SQLite index; ISSUE-007 (full hash on every call) | None | MISS | Sharding, scale test |
| NFR-3 | ≥ 8 local agents/workspace; ≥ 1,000 cloud sessions (M4) | §10 | DAG concurrency in PR #19 | M3 DAG (partial) | DEF(M3) | Concurrency test at 8 agents; cloud scale |
| NFR-4 | Engine survives UI crash; resume from checkpoint; no data loss | §4 | Separate engine process; restart resume (M0 eval); desktop restarts engine | M0 | RED | Desktop restart-with-backoff covers engine crash, not verified on a real Electron run |
| NFR-5 | 99.9% control plane; sandbox auto-restore | §28 | None | M4 control plane | NI | All (no SLO item) |
| NFR-6 | macOS + Linux (M1); Windows 11 native + WSL2 (M2) | §16 | Linux only actually run; `sandbox/wsl.ts`, `test/windows.test.ts` (shims) | M2 "Windows support" | NV | No macOS or Windows host verification; WSL lacks egress and fs isolation |
| NFR-7 | Local-first; zero-retention endpoints selectable | §8 | Local-first by design | None | RED | Zero-retention selection |
| NFR-8 | Plugins: providers, sandboxes, deploy, indexers, tools (§31) | §31 | Provider adapters only | None | RED | Plugin interfaces for other categories |
| NFR-9 | WCAG 2.2 AA, keyboard, screen-reader, high contrast | §5 | Some ARIA in `engine/ui` | None | MISS | Audit, high-contrast theme |
| NFR-10 | OTel span per step with tokens, latency, tool I/O refs | §26 | `obs/tracing.ts` | M0 | NV | Completeness not verified |
| NFR-11 | Enforced module boundaries (lint); ≥ 80% coverage | — | No lint boundary rules; no coverage report | None | MISS | All |
| NFR-12 | i18n-ready UI | §5 | None | None | MISS | All |
| NFR-13 | Platform overhead < 20% of LLM spend | — | None | None | MISS | No measurement |

### 3.4 Security requirements (plan §16)

| ID | Original requirement | Evidence on `main` | Roadmap ref | Class | Missing |
|---|---|---|---|---|---|
| SEC-1 | No agent process outside sandbox except explicit trusted light mode, permanently indicated | Silent `local-process` fallback (`sandbox.ts:163`); MCP + Chrome on host | M1 F-SBX-2 | RED | Fail-closed or explicit opt-in; UI indicator |
| SEC-2 | Sandbox sees only workspace; no home/SSH/cloud creds/browser profiles | Mount ns + tmpfs + chroot (`IMPL-ADR-017`); `test/sandbox.test.ts` | M1 | RED | Not true in `local-process` fallback or WSL |
| SEC-3 | Deny-by-default; proxy egress; metadata + private ranges blocked | `sandbox/egress.ts` `isBlockedAddress`, `safeLookup`; `test/egress.test.ts` | M1 T1 | FV | — |
| SEC-4 | Keychain/KMS; sentinels; proxy injects only for bound hosts | `vault/keychain.ts`; masking; `test/masking.test.ts` | M2 | RED | KMS; bindings in memory only |
| SEC-5 | Each MCP server in own sandbox + credential scope; untrusted output; pinned by version + hash | Untrusted wrapping only | None | MISS | Sandboxing, credential scope, pinning |
| SEC-6 | Approvals enforced in engine policy; prompts cannot change policy | `policy/policy.ts`; `test/mcp-safety.test.ts` | M1 | NV | Red-team prompt-injection suite (§15.5) |
| SEC-7 | No force/protected push without approval; secret scan before commit and push | Hard deny (`IMPL-ADR-022`) | M1 T5 | RED | Pre-commit/pre-push secret scan |
| SEC-8 | Installs via dependency gate; install scripts sandboxed without secrets | `policy/depgate.ts` for agent `run_shell`; sentinels only in sandbox env | M2 | RED | Installs from hooks, dev server, MCP; install-script policy |
| SEC-9 | Audit append-only, hash-chained, exportable | `events/bus.ts` chain | M0; export M4 | RED | Export (M4) |
| SEC-10 | RFC 8252 OAuth with PKCE; no foreign credential stores | Denylist of foreign stores (`vault/vault.ts:15`) | M4 OAuth broker | DEF(M4) | OAuth |
| SEC-11 | Provider data handling shown; zero retention; org can restrict providers | Org restriction of models/providers only | None | MISS | Data-handling display, zero retention |
| SEC-12 | Reaper for orphaned sandboxes; no secrets on disk in snapshots | No reaper; no snapshots | None | NI | Reaper |
| SEC-13 | Electron: context isolation, sandboxed renderer, no nodeIntegration, strict CSP, IPC allowlist | `packages/desktop/main.cjs`, `preload.cjs`; CSP header `engine.ts:499`; `desktop.test.mjs` headless smoke | M2 | RED | CSP is not strict (`frame-ancestors *`, `style-src 'unsafe-inline'`); no IPC channels exist, so there is no allowlist to validate; smoke test does not launch Electron in CI |
| SEC-14 | Signed releases, SBOM, reproducible builds, pinned deps | `pnpm-lock.yaml` only | None | MISS | Signing, SBOM, reproducibility |

### 3.5 Performance requirements (plan §17)

No PERF budget is measured by any test or eval on `main`. The only roadmap reference is the uncounted M1 launch gate ("original M1 exit criteria from plan.md §12"), so every PERF item is **NI**.

| ID | Budget (p95) | Relevant code | Measured? | Class | Blocker |
|---|---|---|---|---|---|
| PERF-1 | Desktop cold start ≤ 2.5 s | `packages/desktop/main.cjs` | No | NI | No real Electron run in CI |
| PERF-2 | Editor keystroke ≤ 16 ms | — | No | NI | No editor (Monaco missing) |
| PERF-3 | Engine overhead before first byte ≤ 300 ms | `context/assembler.ts`, `models/router.ts` | No | NI | No harness |
| PERF-4 | Exact search 1M LOC ≤ 100 ms | `search` tool | No | NI | No 1M LOC fixture |
| PERF-5 | Hybrid retrieval ≤ 150 ms | `index/index.ts` | No | NI | Brute-force cosine; no fixture |
| PERF-6 | Cold index 1M LOC ≤ 5 min | `index/index.ts` | No | NI | No fixture |
| PERF-7 | Incremental re-index ≤ 300 ms | `index/index.ts` | No | NI | No watcher (ISSUE-007) |
| PERF-8 | Impact report 1M LOC ≤ 500 ms | `index/graph.ts` | No | NI | No fixture |
| PERF-9 | Sandbox warm ≤ 2 s, cold ≤ 15 s | `sandbox/sandbox.ts` | No | NI | No suspend/resume |
| PERF-10 | Snapshot ≤ 400 ms | `preview/browser.ts` | No | NI | No timing assertion |
| PERF-11 | Checkpoint create ≤ 200 ms / restore ≤ 1 s (1k files) | `agent/runtime.ts:621` | No | NI | No fixture |
| PERF-12 | Engine idle memory ≤ 1.5 GB at 1M LOC | — | No | NI | No fixture |
| PERF-13 | Event stream ≤ 50 ms | `events/bus.ts` | No | NI | No harness |

---

## 4. Special-attention areas

| Area | Original | Status on `main` | Verdict |
|---|---|---|---|
| **Electron + Monaco IDE** | Electron workbench, Monaco, xterm, dockable layout, palette (FR-33, F-UI-1, §1.4 "Helix uses Chromium, Monaco, and xterm.js") | Minimal Electron shell loading an HTML workbench; xterm present; **no Monaco** | Reduced; **editor, docking, palette, Problems, MCP manager, Intelligence Explorer are missing from the roadmap** |
| **Sandbox isolation** | Containers/gVisor/microVM; whole toolchain; limits; reaper | unshare + chroot; silent unisolated fallback; MCP + Chrome on host; no cgroups | Reduced; ticked items overstate containment |
| **Credential masking** | Sentinels + TLS proxy for all tools incl. MCP | Works for sandboxed HTTP(S); MCP excluded; bindings in memory | Reduced |
| **Code intelligence + SCIP** | tree-sitter ×20, SCIP + 5 LSPs, full graph | tree-sitter ×6, TS LanguageService only, name-based graph | Reduced; no SCIP |
| **Semantic vector search** | Neural/provider embeddings | Lexical feature hashing | Reduced; "semantic" label not accurate |
| **Browser automation** | 12 action tools, record/replay | screenshot, console, snapshot | Reduced; interaction tools missing from roadmap |
| **Element→source** | Compiler plugins + fiber; ≥ 95% on React/Vue/Svelte | Pre-existing attribute or text match; synthetic 24/24 | Reduced; AC not met on real apps |
| **MCP** | stdio + HTTP, sandboxed, 4 trust tiers, extensions, search, compression | stdio + HTTP, 2 tiers, search, cache; host processes | Reduced; extensions and sandboxing missing |
| **Git** | Full SCM + shadow store + worktrees + PRs + safeguards | status/diff/stage-all/commit; blob checkpoints; push guards | Reduced; PR creation missing from roadmap |
| **Multi-agent orchestration** | Subagent types, DAG, leases, merge agent, background | Explore only on `main`; DAG/leases in draft PR #19 with defects | Deferred (M3) |
| **Review + security agents** | Review agent, SAST, secrets, IaC, dep gate | Dep gate (OSV only) | Review agent and SAST **missing from roadmap** |
| **Testing + eval benchmarks** | §15: agent eval suite, O1–O5, retrieval eval, red-team, browser eval | m0-exit (live), m1-demo (live), m2-eval (offline, fake provider) | O1–O5, red-team, retrieval eval are uncounted launch gates or absent |
| **Performance** | 13 budgets | None measured | Not implemented |

---

## 5. Advanced feature proposals (plan §5, X-IDs)

| X | Feature | Original verdict | Current status | Class |
|---|---|---|---|---|
| X1 | Environment Snapshot | Build (M1) | Snapshot without pHash/build status (M2) | RED |
| X2 | Element→source | Build (M2) | Minimal (M2) | RED |
| X3 | Code graph + impact | Build (M1 v1, M2 full) | v0 graph (M2) | RED |
| X4 | Verification gates | Build (M1) | Implemented; no waiver | RED |
| X5 | Leases + worktrees | Build (M3) | PR #19 | DEF(M3) |
| X6 | Ledger + budgets | Build (M1) | task/day budgets | RED |
| X7 | Tool search | Build (M2) | Implemented | FV |
| X8 | Fix-history memory | Build (M3) | Roadmap M3 | DEF(M3) |
| X9 | Auto ADRs | Build (M4) | Roadmap M4 | DEF(M4) |
| X10 | Visual regression | Build (M3) | Roadmap M3 | DEF(M3) |
| X11 | Bug auto-repro | Build (M3) | Roadmap M3 | DEF(M3) |
| X12 | Architecture diagrams | Build (M3) | Roadmap M3 | DEF(M3) |
| X13 | Credential masking | Build (M2) | Minimal (M2) | RED |
| X14 | Replayable sessions | Build (M2) | Implemented | FV |
| X15 | Cost-aware router | Build (M2 rules, M4 learned) | Rules v1; learned M4 | RED |
| X16 | Spec-by-example | Build (M3) | Roadmap M3 (E2E from recordings) | DEF(M3) |
| X17 | Dependency risk gate | Build (M2) | OSV only | RED |
| X18 | Shared team memory | Build (M4) | Roadmap M4 | DEF(M4) |
| X19 | Unattended prod deploy | **Reject** | Not built | REJ |
| X20 | LLM docs for every file | **Reject** | Not built | REJ |
| X21 | Screenshot every step | **Reject** | Not built (snapshot used) | REJ |
| X22 | Custom small models | Defer (M5+) | Roadmap M5 | DEF(M5) |
| X23 | Multiplayer co-editing | Defer (M6) | Roadmap M6 | DEF(M6) |
| X24 | Execution-flow visualization | Defer (M5) | Roadmap M5 | DEF(M5) |
| — | Inline/tab completion | Won't (M3) | Roadmap M3 | DEF(M3) |

---

## 6. Original milestone exit criteria vs current status

| Milestone | Original exit criteria (plan §12) | Current treatment | Status |
|---|---|---|---|
| M0 | CLI fixes seeded test in 3 fixture repos in a container; ledger reconciles; restart resumes | `evals/m0-exit.ts` live 3/3 (process sandbox, not container) | Met except "inside a container" |
| M1 | O1 ≥ 55%, O2 ≥ 90%, O4 = 0 High, PERF budgets, 10-user usability (≥ 7/10) | Moved to uncounted launch gate; `evals/m1-demo.ts` single live demo | **Not met** |
| M2 | O3 ≥ −40% cost, O5 ≥ 0.70, element→source ≥ 95%, MCP ≤ 3k tokens/turn | m2-eval offline: MCP 240 tokens (met); cost 21.1% of baseline via fake provider; e2s 24/24 synthetic; O5 not measured | Partially met; O5 and e2s on real apps not shown |
| M3 | 300-file migration zero lost writes; durable background runs; visual regression FP ≤ 5% | Roadmap item "M3 eval" | Not started |
| M4 | 3 pilots, SOC 2 Type I, external pen test | Launch gate | Not started |

---

## 7. Requirements missing from the current roadmap (action list)

None of these has a counted roadmap item. Adding them as top-level roadmap items needs the user's permission, because AGENTS.md forbids AI sessions from adding items.

**Numbered requirements classified MISS (17):** FR-13, FR-21, FR-23, FR-36, F-GIT-4, F-VIS-4, F-REV-1, F-REV-2, F-UI-3, NFR-2, NFR-9, NFR-11, NFR-12, NFR-13, SEC-5, SEC-11, SEC-14.

**Not implemented, no counted item (17 NI):** PERF-1…13 (no benchmark harness), NFR-1, NFR-5, SEC-12, F-TEAM-3.

**Unscheduled sub-capabilities of requirements classified RED:** Monaco editor, docking, command palette, Problems panel, MCP manager (FR-33, F-UI-1); browser interaction tools (F-PRV-5); local-container/gVisor backend (F-SBX-1); MCP extension negotiation and sandbox spawn (FR-25, F-MCP-1); explicit provider prompt caching (F-TOK-4, F-MDL-2); multimodal image input (F-MDL-2); structured output (F-MDL-1); MCP 2026-07-28 spec revision (FR-25); `CLAUDE.md` / `.cursor/rules` import (F-CTX-3, FR-30); SCIP and non-TS language servers (F-IDX-2); multi-tab preview and device emulation (F-PRV-2); 14 additional tree-sitter languages (F-IDX-1); review subagent types (F-ORC-1).

Recommended order to restore scope: (1) contain MCP servers and Chrome in the sandbox and fail closed when isolation is unavailable (SEC-1, SEC-5, F-SBX-2); (2) browser interaction tools (FR-23); (3) SAST + review agent (F-REV-1/2); (4) PERF harness on a 1M LOC fixture; (5) Monaco editor + Problems panel (FR-33).
