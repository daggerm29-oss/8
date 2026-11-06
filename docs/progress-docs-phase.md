# Progress Log — AI Dev Environment Research & Planning

> Purpose: lets any future AI session resume this task without starting over.
> Task source: user brief "Build a Next-Generation AI Development Environment — Research, Product Planning & Architecture".
> Deliverables (ONLY): `plan.md` and `architecture.md` (+ this `progress.md` tracker, explicitly requested by the user).
> Hard constraints: NO application code, NO prototypes, NO dependency installs, NO extra project files.
> Working codename for the product in both docs: **Helix**.

## Status: COMPLETE (chat 2, 2026-11-06)

All deliverables are finished and cross-checked: `plan.md` (20 sections + Appendices A–C) and `architecture.md` (34 sections, 26 Mermaid diagrams, per-ID traceability in §31.4). No further work is required. Any future session should only make targeted revisions requested by the user. Re-run the cross-check described under "Chat 2" after edits.

## Plan
1. [x] Research (web) — done, notes below.
2. [x] Write `plan.md` (20 required sections + appendices A traceability, B open questions, C glossary). DONE (951 lines).
   - Arch § references used in plan.md (architecture.md MUST honor these numbers/sub-numbers): §5, §5.4–5.6, §7, §7.3–7.6, §8, §8.5, §9, §9.4–9.7, §10, §10.2–10.6, §11, §11.4–11.7, §12, §12.3, §13, §13.4–13.6, §14, §14.4, §14.6, §15, §15.4, §16, §16.3–16.7, §17, §17.2, §18, §18.3–18.7, §19, §19.4, §20, §20.3–20.6, §22.6, §25, §25.6, §25.8, §26, §26.4–26.5, §28, §29, §29.2, §29.4, §29.6, §31.
3. [ ] Write `architecture.md` (34 required sections — brief §12 File 2) in two passes:
   - [x] Pass A: sections 1–17 DONE (1116 lines). File ends with marker `<!-- ARCH-PASS-B -->`.
   - [x] Pass B: sections 18–34 DONE (verified in chat 2: file is 2109 lines, marker removed, §18–§34 present, ends with ADR table ADR-001…ADR-023).
   - (original Pass B instructions kept for reference) sections 18–34 — replace the marker line with content. Must include §18.3–18.7, §19.4, §20.3–20.6, §22.6, §25.6, §25.8, §26.4–26.5, §28 (incl. §28.4 session handoff), §29.2/29.4/29.6, §31, Mermaid data-flow diagrams (§30), repo tree (§32), ADR list (§34; ADR-002 = Code-OSS fork rejected, revisit trigger).
4. [x] Cross-check: every F-ID in plan.md maps to an architecture.md section (per-ID table now in arch §31.4).
5. [x] Mark complete.

## Completed
- Research round (Nov 6, 2026).

## Key decisions (keep consistent across both docs)
- Headless **Helix Engine** (TypeScript/Node orchestration + Rust native modules via napi-rs) shared by Desktop (Electron + React + Monaco + xterm.js), CLI/TUI, and cloud workers. Modular monolith, no microservices at start.
- Storage: per-workspace SQLite (WAL) + Tantivy (BM25) + LanceDB (vectors); cloud: Postgres + pgvector + S3.
- Indexing: tree-sitter + SCIP/LSP for precise refs, code graph in SQLite, hybrid retrieval (BM25 + vector + graph expansion + rerank).
- Sandbox: SandboxProvider interface; local = rootless container (optionally gVisor) or OS sandbox light mode; cloud = Firecracker microVMs (self-host) or provider (Vercel Sandbox/E2B). Egress proxy w/ allowlist + credential masking.
- Browser: Playwright/CDP Chromium in sandbox; injected runtime probe; dev-time source-location instrumentation; "Environment Snapshot" (a11y-tree refs + console/network digests + perceptual-hash screenshots on demand).
- Agents: one primary agent + isolated subagents (explore, browser-verify, test, review); task DAG orchestrator; file write leases; git worktree per parallel agent; shadow-git checkpoints.
- MCP: spec 2026-07-28 (stateless requests; extensions Tasks, Skills over MCP, MCP Apps); tool registry + tool-search meta-tool (deferred schemas); result compression + cache; MCP servers sandboxed; tool output = untrusted.
- OpenAI auth: API key + official "Sign in with ChatGPT" (SIWC) OAuth/OIDC+PKCE; NEVER read Codex `~/.codex/auth.json`. Commercial SIWC = limited trial (needs partnership); OSS clients eligible.
- Gemini: user API key; models from ai.google.dev list (gemini-4-argon, gemini-3.8-flash, gemini-3.5-flash-lite, gemini-embedding-2); context caching.
- No time estimates in roadmap — use milestones, T-shirt complexity, exit criteria.

## Research notes (source → finding)
- Cursor changelog (cursor.com/changelog): Nov 5 2026 "Build Live Apps" (cloud agent scaffolds app, Postgres, SSO auth, hosting, security checks before publish); Oct 20 Agent SDK (agents-as-code: instructions.md, tools/, skills/, mcp-connections/, channels/, evals); Oct 16 cloud agent canvases, Environments API beta, up to 300 repos/env; Oct 13 Origin App Marketplace; Oct 6 remote control of local agents via iOS. Search summary: async subagents, always-on cloud agents w/ event subscriptions, /goal, /in-cloud subagents.
- Cursor docs/semantic-search: Instant Grep (custom engine, local index, "does not store embeddings of your codebase for search"), Explore subagent w/ own context + faster model. Multi-root supported; worktrees disabled in multi-root; cloud agents no multi-root.
- Cursor models page: very large multi-provider catalog (Anthropic, OpenAI GPT-5.x, Gemini 3.x/4 Argon, Composer 2.5, Grok 4.x, Kimi, GLM, DeepSeek, Meta Muse); Max Mode; per-model context 200k–1M.
- Antigravity docs home: surfaces = Antigravity 2.0 desktop (Projects, workspaces/worktrees, parallel local subagents, Scheduled Tasks, voice), CLI (TUI), SDK (Python, declarative safety policies, inspect/decide/transform hooks), IDE. Harness co-trained w/ Gemini; Gemini 3.8 Flash powers local agents; Visual Artifacts (plans, diffs, browser recordings); local proxying + tool approval gates. Search: Agent panel @/slash, per-turn Accept/Reject, Local vs New Worktree mode, /goal /grill-me /schedule /browser; browser subagent controls local Chrome, screenshots + WebM recordings; artifact review policies.
- Claude Code overview (code.claude.com/docs/en/overview): surfaces terminal/IDE/desktop/web/JetBrains; CLAUDE.md (reads AGENTS.md), auto memory, skills, hooks, MCP, parallel agents w/ lead agent, background agents, Agent SDK, cloud scheduled tasks, /loop, Remote Control, Channels, teleport, GitHub Code Review, Chrome for debugging live web apps.
- Claude Code sandboxing: OS-enforced (Seatbelt macOS, bubblewrap+socat Linux/WSL2), via @anthropic-ai/sandbox-runtime; covers shell only (file tools, MCP, hooks outside); default reads most of machine; network via local proxy allowlist; credential deny/mask w/ sentinel + TLS-terminating proxy injection; strict mode disables unsandboxed retry; repo settings can't loosen admin-required sandbox.
- v0 docs: prompt→app, design mode, Git/PR, one-click deploy, auto error fixing, web search, site inspection, MCP; previews run in Vercel Sandbox VMs (search summary).
- Vercel Sandbox docs: Firecracker microVMs, ms startup, persistent by default, snapshots, drives, multi-agent Linux users, Active CPU pricing, OIDC auth, custom OCI images.
- OpenAI Codex auth docs: ChatGPT sign-in or API key; Codex cloud requires ChatGPT sign-in; creds cached in ~/.codex/auth.json (plaintext) or keyring; Enterprise Codex access tokens for automation; forced_login_method.
- OpenAI SIWC (developers.openai.com/siwc/quickstart; openai.com/form/sign-in-with-chatgpt-interest/): OIDC + PKCE; identity scopes `openid profile email`; separate Responses API scopes for plan usage; OSS clients register w/o client secret; commercial partners = limited trial via interest form; Plus/Pro plan usage.
- Gemini models (ai.google.dev/gemini-api/docs/models, updated 2026-10-28): gemini-4-argon (flagship, 1M ctx), gemini-3.8-flash, gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview, gemini-embedding-2 (multimodal), antigravity-preview-09-2026 managed agent; 2.5 models restricted to prior users; computer-use model shut down.
- MCP spec latest (2026-07-28): JSON-RPC 2.0; stateless self-contained requests; per-request capability negotiation; server features Resources/Prompts/Tools; client feature Elicitation; extensions Tasks, Skills over MCP, MCP Apps; tool annotations untrusted unless trusted server.

## Chat 2 (resume) log
- Pulled files from github.com/daggerm29-oss/3 into the v0 project root (plan.md, architecture.md, progress.md).
- Confirmed architecture.md Pass B finished in chat 1 (progress.md had not been updated before tokens ran out).
- NOW: step 4 cross-check — (a) every `§N.N` cited in plan.md exists as a heading in architecture.md; (b) every F-ID in plan.md appears in architecture.md; (c) Mermaid/code fences balanced; (d) required section lists complete (plan 20, arch 34). Fix any gaps with small targeted edits.

- Cross-check results: all plan `§` refs resolve (only `§15.6` is a plan-internal ref, OK); fences balanced (arch 26 Mermaid blocks); plan 20/20 + arch 34/34 sections present.
  - GAP 1: 10 F-IDs were not named in architecture.md (F-AGT-1, F-AUTH-1/2, F-GIT-1, F-IDX-1, F-MDL-1, F-OBS-1, F-PRV-2, F-REV-2, F-SBX-1). 13 X-IDs not named (X5–7, X11–13, X15, X18, X20–24).
  - GAP 2: F-REV-2 (SAST/secret/IaC) had no dedicated arch subsection.
  - FIXED: added arch §25.10 (security analysis pipeline) + `security_findings` row in §21.1; plan F-REV-2 now has AC + points to §25.10; plan Appendix A points to arch §31.4/§31.5.
  - DONE: added arch §31.4 (per-ID traceability table for all 76 F-IDs + X1–X24) and §31.5 (hooks for deferred/rejected X19–X24).
  - Re-check PASSED: all 76 F-IDs and 24 X-IDs appear in architecture.md; all arch-internal `§` refs resolve; 94 fences balanced (26 Mermaid).
- Step 4 [x] Cross-check done. Step 5 [x] Marked complete.

## Next step
- None. The task is complete. Optional future work, only if the user asks: run the hands-on competitor verification protocol (plan §15.6), or start M0 implementation from architecture.md §33.1. The original brief forbade implementation in this phase.
