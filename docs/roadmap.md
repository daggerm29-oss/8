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
- [x] Precise references via SCIP/LSP (F-IDX-2) [§11.4]
  - Evidence: `node --test test/precise.test.ts test/graph.test.ts` → 4/4 pass (language service in sandbox: a.ts format refs = alias.ts:1,3 + both.ts:1,4; b.ts format = both.ts:4 only; impact output `precise` with alias `total` caller found and `B.format` attributed to b.ts, heuristic mode differs); tsc 0 errors; commit 0606cae
  - Minimal tier 2: TypeScript language service (`findReferences`, workspace or Engine `typescript`) runs in its own contained sandbox for TS/JS definitions; `impact` uses it for depth-1 callers (`precision: 'precise'`), heuristic fallback otherwise. No SCIP, no cache. Accept: new `test/precise.test.ts` on a fixture with two unrelated `format` functions, a namespace call `B.format()` and an aliased import shows precise callers = exactly the true references (alias found, `B.format` excluded) while heuristic mode differs.
- [x] Impact Report attached to Plan Mode artifacts [§11.5]
  - Evidence: `node --test test/plan-impact.test.ts` → 1/1 pass (fake-model Plan Mode: plan.impactArtifactId = impact artifact; direct src/cart.ts, depth-2 src/api.ts, tests test/cart.test.ts, uncovered src/tax.ts, risk 3.58 = 1.58 + 1 + 1 with terms shown, tool result names dependents not in plan); `node --test test/m1.test.ts` → 8/8; tsc 0 errors; commit 972582c
  - `submit_plan` computes a deterministic Impact Report over the plan's existing files (changed symbols, direct + depth-2 reverse-import dependents, covering tests, uncovered files, dependents missing from the plan, risk score with each term shown) and saves it as an `impact` artifact linked from the plan. Accept: new `test/plan-impact.test.ts` — fake-model Plan Mode run citing `src/price.ts` yields a plan with `impactArtifactId` whose report lists cart.ts (direct), api.ts (depth 2), test/cart.test.ts, and explained risk terms.
- [x] tree-sitter parser swap for the symbol index [§11.2] (deferred from M1)
  - Evidence: `node --test test/treesitter.test.ts test/m1.test.ts test/graph.test.ts test/plan-impact.test.ts` → 15/15 pass (TS multi-line signature `total` 1-6 + one-line methods Cart.add/Cart.clear the heuristic misses; broken TS still yields ok/half/Later/Later.run; decorated Py methods Api.name 3-4/Api.make 7-11; Go generic receiver Server.Start 3-7; Rust impl method Wrap.fmt 3-6 despite `"}"`; Java package-private Shop.restock the heuristic misses; Kotlin/Markdown stay heuristic); tsc 0 errors; commit cdd4798
  - `extract()` parses TS/JS/Python/Go/Rust/Java with tree-sitter (`@vscode/tree-sitter-wasm`, grammars loaded once at module load) and walks the syntax tree into the same §11.3 symbol model; heuristic regexes stay as fallback (other languages, or WASM unavailable). Imports unchanged. Accept: new `test/treesitter.test.ts` — snippets per language yield `parser: 'tree-sitter'` and symbols the heuristic misses (multi-line signatures, one-line class methods, decorated multi-line Python methods, Java package-private methods; Rust impl fns typed as methods) with correct line ranges; a syntax-broken TS file still yields its intact symbols; `m1`, `graph`, `plan-impact` tests still pass.
- [x] Local-first vector embeddings in hybrid retrieval (F-IDX-6) [§12.3] (deferred from M1)
  - Evidence: `node --test test/vectors.test.ts test/m1.test.ts test/core.test.ts test/plan-impact.test.ts` → 18/18 pass ("tokenization routine" → src/lexer.ts `tokenizeSource` with why ['vector'] only; identical `clamp` chunks in a.ts/b.ts share one hash, embeddings = chunks − 1; second update() indexes 0 and embeds 0; no `.env` vector; model helix-local-hash-v1; migration v5 applies); tsc 0 errors; commit e63ca2b
  - Bundled local embedder `helix-local-hash-v1` (signed feature hashing of identifier words + character trigrams, 512-dim, L2-normalized, 5-char prefix + word + trigram features, code keywords skipped; no model download, no network). Each index chunk (header = path + symbol) is embedded into a content-addressed `idx_embeddings` table (hash → vec, model, dim stored per row) so identical chunks are embedded once; `idx_vectors` maps chunks to hashes. `search()` adds a `vector` retriever (brute-force cosine, weight 1.0 natural language / 0.5 identifier queries) to RRF. Secret files are never indexed, so never embedded. Accept: new `test/vectors.test.ts` — query "tokenization routine" (no BM25 term match) returns `src/lexer.ts` `tokenizeSource` with `why: ['vector']`; two identical chunk bodies in different files produce one embedding row; re-running `update()` on unchanged files embeds nothing new; `.env` has no vector; `m1` tests still pass.
- [x] Domain extractors (F-IDX-5) [§11.7]
  - Evidence: `node --test test/domain.test.ts test/m1.test.ts test/core.test.ts test/vectors.test.ts` → 18/18 pass (11 routes across next/next-page/express/fastapi/flask/gin/net-http with handler + file:line; 4 tables prisma/sql/drizzle with columns, SQL FOREIGN KEY skipped; 4 env keys; `sk_live…` literal absent from all domain tables; edited server/index.ts rows replaced; `domain_map` output lists route/table/key, kind filter works); tsc 0 errors; commit 40bcdfc
  - Heuristic extractors in `index/domain.ts` run per indexed file: routes (Next.js `app/**/route.ts` + `page.tsx`, Express/Hono/Fastify `app.get(...)`, FastAPI/Flask decorators, Go `http.HandleFunc`/gin), DB tables (Prisma `model`, SQL `CREATE TABLE`, Drizzle `pgTable/sqliteTable/mysqlTable`), env keys (`process.env`, `import.meta.env`, `os.environ`/`getenv`, Go `os.Getenv`, Rust `env::var`; names only). Stored in `idx_routes/idx_tables/idx_config` (migration v6); read-only agent tool `domain_map {kind}`. No edges, docs, git-history, or package extractors yet. Accept: new `test/domain.test.ts` on a mixed fixture lists every expected route (method, path, handler, file:line), table (with columns), and env key; a secret-looking value next to an env read is absent from the DB; editing a file replaces its rows; `domain_map` tool output contains them.
- [x] Runtime telemetry via CDP + Environment Snapshot (F-PRV-3/4) [§18.3] (deferred from M1)
  - Evidence: `node --test test/snapshot.test.ts test/browser.test.ts` → 2/2 pass (headless Chrome: snapshot 1 has main/heading "Cart"/textbox "Coupon"=SAVE10/button "Checkout" with `@e` refs, viewport 1280, `price service down` ×3 as one entry + browser 404 log, GET /api/missing?token=[redacted]&page=2 → 404 and `abc123` absent from output; snapshot 2 diff: -button Checkout, +link "Need help?", ~textbox value SAVE10→SAVE20, heading ref unchanged; F-PRV-5 browser test still passes); tsc 0 errors; commit 568d113
  - Telemetry: each browser load also records `Network.*` events (method, query-secret-redacted URL, status, type, ms, failure) and dedupes console/exception entries with a count; `preview_console` shows failed requests. Snapshot: `PreviewBrowser.snapshot()` + read-only tool `preview_snapshot {path, full}` returns the §18.4 subset (page/viewport/scroll, pruned AX tree with stable `@e` refs = hash(role, name, landmark path), text digest, focused ref, new console errors/warnings, failed/slow/pending requests) and a ref-level diff vs the previous snapshot of the same URL. No build status, pHash/visual, boxes, or source maps yet. Accept: new `test/snapshot.test.ts` (headless Chrome) on a fixture page — first snapshot lists heading/textbox/button/main refs, a 404 fetch with `?token=` shown redacted, a console error repeated 3× counted once ×3; after the page changes, the second snapshot diff has the removed button, the added link, and the textbox value change while the heading keeps its ref; `browser` test still passes.
- [x] Element→source + select-and-instruct in preview [§17]
  - Evidence: `node --test test/element-source.test.ts test/snapshot.test.ts` → 2/2 pass (headless Chrome via engine RPC: locate before dev server → "no dev server"; preview.inspect PNG 1280 wide; click (100,60) → button "Save changes" .btn.primary → src/SaveButton.jsx:3:10 attribute confidence 1, chain Toolbar.jsx:4 > SaveButton.jsx:3, slice in context; toolbar div → Toolbar.jsx conf 1; unattributed `<p>` → src/Footer.jsx:4 text conf 0.5 needsConfirm; preview.instruct goal = instruction + SaveButton.jsx:3 + card; confirmed path → conf 1; `../etc/passwd` rejected); tsc 0 errors; agent-browser on workbench `:4100` Preview → Inspect → click button → chip `src/SaveButton.jsx:3` + highlight, click text → chip `src/Footer.jsx:4` + "Low confidence. Confirm the file"; commit 971afe6; artifact evals/results/e2s-inspect-attribute.png, evals/results/e2s-inspect-text.png
  - `PreviewBrowser.locate(url, x, y)` returns an element card (tag, role, name, text, classes, box, style summary, `data-helix-loc` of the element/ancestors). `preview/locate.ts` maps it to source: strategy 1 `data-helix-loc="<path>:<line>:<col>"` (confidence 1.0 on the element, 0.9 on an ancestor; outer locs = component chain); strategy 4 fallback = literal text (+ className overlap) found via index search (confidence ≤ 0.8, `needsConfirm`). No compiler plugins, React owner stacks or source maps yet. RPCs `preview.inspect` (screenshot as base64), `preview.locate {x,y}`, `preview.instruct {x,y,instruction}` (creates a task whose goal = instruction + element card + source slice). Workbench Preview tab "Inspect" mode: click on the screenshot → chip `file:line` (+ "confirm file" when low confidence) → instruction box → task. Accept: new `test/element-source.test.ts` (headless Chrome) — click on an attributed button maps to its exact `src/…:line` with confidence 1 and chain; click on unattributed text maps to the file that contains it with confidence < 1 and `needsConfirm`; `preview.instruct` RPC creates a task whose goal has the instruction, `file:line`, and element card; browser check of Inspect mode shows the chip in the workbench.
- [x] Credential masking via TLS-terminating proxy (F-SBX-4) [§16.6]
  - Evidence: `node --test test/masking.test.ts` → 2/2 pass (x509 leaf verified by Node for its host only; sandbox `printenv API_TOKEN` = `helix_sntl_…`, real value absent from env; curl `Authorization: Bearer $API_TOKEN` to api.example.test → upstream saw the real value, 200; JSON body substituted; `$API_TOKEN` in header to other.example.test → 403, upstream got nothing, `secret.exfil_attempt` {API_TOKEN, other.example.test, header x-key}; OTHER_KEY to its own host → real value; sentinel over plain http → 403 + alert; registry.npmjs.org still 200 through the CA bundle); `node --test test/egress.test.ts test/devserver.test.ts test/sandbox.test.ts` → 14/14; tsc 0 errors; commit 58b75e3
  - Minimal tier: RPC `secrets.bind {workspacePath, name, injectHosts, value?}` (value from param or Engine env; in memory) + `secrets.list`; sandbox env gets a sentinel per binding; per-sandbox CA (pure node:crypto X.509) trusted only via the sandbox's CA-bundle env; proxy terminates TLS only for bound hosts, substitutes sentinels in URL/headers/json-form-text bodies for `injectHosts`, else blocks with 403 + `secret.exfil_attempt`; sentinels never leave over plain HTTP. No structured masking, non-HTTP relays, or pinned-cert fallback. Accept: new `test/masking.test.ts` — sandbox env holds only the sentinel; a bound host receives the real value in a header and a JSON body; the sentinel sent to another host is blocked before reaching it and raises `secret.exfil_attempt`; unbound HTTPS hosts still work; `egress` tests still pass.
- [x] Model router v1 (F-MDL-5) [§7.6]
  - Evidence: `node --test test/router.test.ts test/roles.test.ts test/models.test.ts` → 14/14 pass (rule table: summarize/explore → flash-lite, plan → pro, edit → flash; edit after failed gate → pro with "escalated M→L after failed gate (1)"; open circuit moved last; breaker opens after 5 consecutive failures and on ok/fail/ok/fail = 50% in window, open circuit skips provider, half-opens after cooldown, probe closes; router_reason on ok + error ledger rows; e2e js-calc: first coder step gemini-mid [M], after failed gate all coder steps gemini-pro with escalation reason, task done); `node --test test/m1.test.ts test/explore.test.ts test/compaction.test.ts` → 13/13; tsc 0 errors; commit bda5c31
  - `models/router.ts`: rule table step type → tier (plan L, edit M, explore/summarize S), tier from model-name tokens (lite/mini/nano/haiku/small S; pro/opus/ultra/large L; else M); the role chain is reordered by tier distance (ties keep configured order), refs with an open breaker go last; edit steps escalate one tier while the task has a failed gate (repeat failures still end at MAX_VERIFY_ATTEMPTS). Gateway breaker per (provider, model) adds a 60 s error-rate window (≥ 4 outcomes, ≥ 50% errors) beside 5 consecutive failures; `isOpen()`; decision + rationale saved in ledger `router_reason`. No learned scorer, no cross-provider candidate expansion. Accept: new `test/router.test.ts` — rule-table picks per step type from a mixed chain, escalation reason after a failed gate (unit + e2e ledger rows), breaker opens on 5 consecutive and on 50% window errors, skips the provider while open, half-opens after cooldown; `roles` and `models` tests still pass.
- [x] Session replay [§30]
  - Evidence: `node --test test/replay.test.ts` → 1/1 pass (fake-model js-calc run → bundle: 4 model turns with ref + router reason, 3 tool calls read_file/edit_file/run_shell ok, 7-entry timeline, `ghp_…` token absent and shown `[REDACTED:github-token]`; replay after restoring calc.js: identical, 4/4 turns, 3/3 tools, final text matches, 0 extra provider calls, file untouched, `replay` artifact saved; recording with edit_file denied → "tool call 2: edit_file was denied in the recording but is allowed now"; recording cut to 3 turns → "model turn 4 requested but the recording has only 3"); `node --test test/replay.test.ts test/router.test.ts test/roles.test.ts test/m1.test.ts test/core.test.ts` → 23/23; tsc 0 errors; commit 5c59a76
  - Spec is §26.4 (F-OBS-2). `replay/bundle.ts`: `exportBundle` builds a session bundle from the task's messages, tool_calls and ledger (primary model turns with IR message, role, ref, router_reason, usage; tool calls with args, status, result, provenance; inspect timeline), passed through the output redactor. Deterministic replay `runtime.replay(bundle)`: new headless task on provider `replay` (hidden `ReplayAdapter` keyed per replay) for every role; tool results come from a `ToolScript` instead of running tools (policy still evaluated); no verification gates; report = identical flag, turn/tool counts, final-text match, first divergence (tool name/args mismatch, allowed↔denied change, missing/extra model turns). RPCs `task.bundle {task}`, `task.replay {task | bundle, workspacePath?}`. No re-execute-from-step-N, no subagent/compaction/plan-mode replay, no export consent UI yet. Accept: new `test/replay.test.ts` — a recorded fake-model run exports a bundle with all turns/tool calls and no secret-looking token; replaying it is identical with zero provider calls and no workspace change; a policy change vs the recording and a truncated recording each report the first divergence.
- [x] Artifacts view v2 with structured evidence (F-UI-4) (deferred from M1)
  - Evidence: `node --test test/evidence.test.ts test/gates.test.ts` → 4/4 pass (2 `verification_evidence` artifacts: attempt 1 failed exit≠0 changed [], attempt 2 passed exit 0 changed [src/calc.js]; sha256 hash = evidenceHash(body), differs between attempts; reverify → hashOk/allPassed/matchesRecorded true; after re-breaking calc.js → allPassed false, matchesRecorded false; tampered data_json → hashOk false; non-evidence artifact rejected); tsc 0 errors; commit 0563197
  - Each gate run saves a `verification_evidence` artifact (one exit-code assertion per gate: check, command, expected, actual, pass, diagnostics count; changed files; sha256 over the canonical body). RPC `artifact.reverify {id}` re-runs the assertions in a fresh sandbox and reports hash integrity, current pass/fail, and drift vs the recording; the workbench Artifacts tab renders evidence as a table with a Re-verify button. Accept: new `test/evidence.test.ts` — fake-model fix-the-test run yields one evidence artifact per attempt (fail then pass, changed files on the passing one) with a valid content hash; re-verify passes, then reports drift after the code is re-broken, and a hash mismatch after the stored body is edited; `gates` tests still pass.
- [x] Test generation (F-TST) [§19]
  - Evidence: `node --test test/testgen.test.ts test/explore.test.ts test/agent.test.ts test/m1.test.ts` → 18/18 pass (mutants: 5 flips in range, comment line untouched; fake-model run on js-calc `divide`: vacuous typeof test REJECTED "still passes with all 2 mutants" (14 '==='→'!==', 15 '/'→'*' survived), not written; wrong-expectation test REJECTED "does not pass against the current code", not written; real test ACCEPTED "2/2 mutants killed", written + checkpointed, calc.js unchanged, scratch removed); tsc 0 errors; commit 793d731
  - Spec is arch §9.6 "Test generation" (the §19 bracket is the terminal section). Agent tool `propose_test {path, content, target, symbol?, command?}` (exec class): copies the workspace to `.helix/scratch/<id>` (node_modules symlinked), writes the test there, runs it (default `node --test <path>`) — must pass; then applies up to 8 single-operator mutants (=== / !== / < / > / + / - / * / / / && / || / return true|false) inside the symbol's lines (from the index) of the target, one run each — at least one must fail. Only then is the test written to the workspace (checkpointed). No coverage-driven target picking or test-runner subagent yet. Accept: new `test/testgen.test.ts` — on js-calc, a vacuous test and a wrong test for `divide` are rejected and not written, a real test is accepted with its killed mutants listed and written; target file and scratch dir are left clean.
- [x] Skills and hooks (F-AGT-5) [§9.7] (deferred from M1)
  - Evidence: `node --test test/skills.test.ts test/m1.test.ts test/replay.test.ts test/mcp-safety.test.ts test/agent.test.ts` → 20/20 pass (system prompt lists "- release-notes: Write release notes from the changeset", body marker absent; use_skill returns body + scripts/collect.sh; pre_tool hook exit 3 blocks `run_shell` with DROP → "blocked by pre_tool hook", dropped.txt not created, untrusted+taint; post_tool output appended to edit_file result as untrusted (origin hook:post_tool), GEMINI_API_KEY absent inside hook; task_done hook wrote "task finished: done" + hook_output artifact; invalid event rejected); tsc 0 errors; commit 4da9a81
  - Skills: `skills/<name>/SKILL.md` and `.helix/skills/<name>/SKILL.md` with front-matter `name`/`description`; only those lines go into the composed context; read-only tool `use_skill {name}` returns the body and `scripts/` list. Hooks: `.helix/hooks.json` `{hooks: [{event: pre_tool|post_tool|task_done, match?, run, timeoutMs?}]}` (JSON, no YAML dependency), run in the task sandbox with HELIX_EVENT/HELIX_TOOL/HELIX_TOOL_ARGS/HELIX_TASK_STATUS; non-zero pre_tool blocks the call; post_tool output appended as untrusted (tainted) tool output; task_done saved as `hook_output` artifact. No pre_commit/session_start, triggers, or tool_search indexing yet. Accept: new `test/skills.test.ts` — skill name+description in the system prompt but not the body, `use_skill` returns the body; a pre_tool hook blocks a matching shell call (command not run); a post_tool hook's output appears in the tool result marked untrusted and cannot see provider keys; a task_done hook runs; an invalid hooks file is rejected.
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
