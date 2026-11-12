# OpenHands Benchmarks Audit for R1.39 (Helix Task Suite)

Read-only research. No HTS implementation or dataset download is approved. Does not override `plan.md` > `architecture.md` > `docs/roadmap.md` > `AGENTS.md`. User decisions Q4-Q7 are recorded in section 8 and in `../openhands-reuse-handoff.md` section 5.

- Repo: `OpenHands/benchmarks` @ `60b3548cea8b41276ac0d44ea36a01b82936bbe4` (2026-11-09), MIT, "Copyright (c) 2025 All Hands AI".
- Target: R1.39 (roadmap l.281-282): `node evals/hts/validate.mjs` -> >= 300 tasks, >= 30 OSS repos (TS, Python, Go, Rust, Java), hidden acceptance tests that fail before and pass on the reference solution, browser assertions for UI tasks, HTS-lite of 30 tasks.

## 1. What the repo is

An evaluation orchestrator, not a dataset. Each `benchmarks/<name>/` has `run_infer.py` (agent run per instance) and `eval_infer.py` (scoring). Task data is downloaded from third-party Hugging Face datasets or upstream harnesses. It depends on the Python `software-agent-sdk` (pinned as a git submodule in `vendor/`), `litellm==1.93.0`, Docker/Modal, and per-benchmark Python packages (`swebench==4.1.0`, `multi-swe-bench`, `swt-bench`, `programbench`, `commit0`, `swesmith`). Python only; no TypeScript.

## 2. Benchmarks present and relevance to HTS

| Benchmark | Source data | Languages | Hidden tests | Relevance |
|---|---|---|---|---|
| SWE-bench Verified / Multilingual / Multimodal | HF `princeton-nlp/SWE-bench_Verified`, `SWE-bench/SWE-bench_Multilingual` (license:mit), `.._Multimodal` | Py (Multilingual adds Java, JS/TS, Go, Rust, C/C++, PHP, Ruby) | `test_patch` + FAIL_TO_PASS / PASS_TO_PASS | Methodology template; Multilingual is a candidate task source |
| SWE-bench Pro | HF `ScaleAI/SWE-bench_Pro` (no licence metadata) | multi | same model, official harness ref | Source candidate; licence unverified |
| Multi-SWE-bench | HF `ByteDance-Seed/Multi-SWE-bench` (`license:other`) | Java, Go, C, TS/JS, Rust | harness-run | Closest to HTS language mix; licence needs reading |
| SWT-bench | external `swt-bench` | Py | test-generation scoring | Not needed |
| Terminal-Bench (via Harbor) | `laude-institute/terminal-bench` | shell | per-task test scripts in container | Harness pattern for non-repo tasks |
| Commit0, GAIA (gated), ProgramBench, OpenAgentSafety, SWE-Gym/smith, HybridGym, SWEfficiency | various | mostly Py | various | Out of HTS scope |
| `legacy/miniwob` | MiniWoB | web | reward script | Only browser-flavoured eval; legacy, not maintained in this repo |

No benchmark covers "UI task with browser assertions". HTS browser tasks must be authored by Helix.

## 3. Evaluation architecture (what to learn from)

1. **Two-phase separation.** `run_infer.py` runs the agent in a container and records only `git_patch` (`model_patch`) plus metrics and conversation archive; it does `git reset --hard` / diff extraction at the end (`swebench/run_infer.py` l.473). Scoring is a separate step: `eval_infer.py` feeds `{instance_id, model_patch}` predictions to `swebench.harness.run_evaluation` (`swebench/eval_infer.py` l.150-153), which applies the held-out `test_patch` in a fresh container. **Hidden tests are never present in the agent's workspace.** This is the property R1.39 requires and Helix can reproduce with its own sandbox: agent works in checkpointed worktree, hidden tests overlaid only in the grader sandbox.
2. **Instance model.** `utils/models.py` (`EvalInstance`, `EvalOutput`, `EvalMetadata`), `utils/evaluation.py` (1256 lines: thread pool, cgroup-aware worker count, resume from JSONL, cost via proxy, failure classifier, conversation archive). Useful ideas: JSONL resume, per-instance attempts, failure classification, cost aggregation. Helix already has a ledger and run store; borrow field ideas only.
3. **Iterative / multi-attempt mode** (`utils/iterative.py`, `utils/critics.py`): re-run failed instances up to N attempts, pick best per instance. Candidate input for HTS pass@k reporting.
4. **Image builds** (`swebench/build_images.py`, `Dockerfile.*`, `build_manifest.py`): per-instance Docker images; heavy. Helix HTS needs a lighter per-repo base + pinned commit instead of SWE-bench's per-instance images.
5. **Harbor/Terminal-Bench**: external harness with its own task format (instruction + Dockerfile + test script). Good reference for a minimal task-directory schema.

## 4. Hidden-test methodology (summary)

| Aspect | SWE-bench style | Helix HTS requirement |
|---|---|---|
| Held-out tests | `test_patch` applied at scoring | `hidden/` dir excluded from agent mount, applied in grader sandbox |
| Validity proof | FAIL_TO_PASS fails on base, passes on gold | `validate.mjs` must run base (fail) and reference (pass) per task |
| Regression guard | PASS_TO_PASS | include selected PASS_TO_PASS |
| Contamination | public repos/PRs, likely in training data | HTS should prefer post-cutoff commits or synthesised mutations; record commit dates |
| Flakiness | rerun filtering done upstream | `validate.mjs` should run reference k times |

## 5. Licences and obligations

- Harness code: `OpenHands/benchmarks` MIT, `SWE-bench/SWE-bench` MIT (GitHub API), `SWE-bench_Multilingual` dataset card `mit`.
- `Multi-SWE-bench`: `license:other` -> read the dataset card before any reuse.
- `SWE-bench_Verified`, `SWE-bench_Pro`, `SWE-Gym-Raw`: no licence field in Hugging Face metadata -> **unverified**. Underlying repos each carry their own licence (task content = third-party source code and tests), so per-task licence tracking is needed regardless.
- `GAIA`: gated; out of scope.
- `terminal-bench`: GitHub API returned no SPDX id -> unverified.
- Any copied task text or test vectors need provenance (repo, SHA, path) in a task manifest and notice file. I did not verify licences of individual upstream repos.

## 6. Reusable pieces and integration effort

| Piece | Reuse mode | Effort | Notes |
|---|---|---|---|
| Two-phase infer/score contract + hidden `test_patch` model | Idea (re-implement) | Low | Core of `validate.mjs` and grader |
| Task record fields (instance id, base commit, gold patch, F2P/P2P, test cmd, language) | Schema inspiration | Low | Use JSON per task in `evals/hts/tasks/` |
| Multi-SWE-bench / SWE-bench Multilingual instances as seed tasks | Data (after licence check) | Medium | Gives Java/Go/Rust/TS coverage; needs conversion + per-repo sandbox setup; many require heavy per-instance images |
| Python orchestrator, SDK submodule, litellm, Modal | Do not adopt | High | Second runtime; violates "no second agent runtime" |
| Harbor task layout | Idea | Low | Minimal schema for command-line tasks |
| Failure classifier, JSONL resume, cost aggregation | Idea | Low | Helix ledger/run store cover most |

Rough gap to R1.39: >= 300 validated tasks is the dominant cost, not code. Seeding from existing datasets could cover part of the TS/Python/Go/Rust/Java mix, but each task still has to pass Helix's own base-fails/reference-passes validation, and UI tasks with browser assertions (plus HTS-lite selection) are entirely new work.

## 7. Recommendation

1. Treat the benchmarks repo as methodology reference only. Do not depend on its code.
2. Define the HTS task schema and `validate.mjs` natively in Node/TS around Helix sandboxes, copying the infer/score separation.
3. Evaluate Multi-SWE-bench and SWE-bench Multilingual as optional seed sources **after** licence review and a contamination decision.
4. Author UI/browser tasks natively (nothing upstream).

## 8. User decisions (Q4-Q7, 2026-11-12) - supersede the earlier open questions

- **Q4 APPROVED and completed:** this bounded read-only audit. No implementation.
- **Q5 APPROVED:** public datasets may seed HTS, subject to licence and provenance verification. Not all 300 tasks must be in-house. Maintain a **per-task licence manifest** covering dataset, original repository, commit, task text, tests and any copied code. **Exclude unverified and `license:other` sources until individually reviewed** (this currently excludes Multi-SWE-bench, SWE-bench Verified/Pro, SWE-Gym and terminal-bench per section 5, until reviewed one by one; SWE-bench Multilingual has an `mit` dataset card but its underlying repositories still need per-task licence records).
- **Q6 APPROVED, hybrid contamination policy:** (1) public benchmark-derived tasks, marked potentially contaminated; (2) post-training-cutoff commits when a model's cutoff is known and verifiable; (3) private Helix-authored tasks and synthetic mutations with hidden tests. Post-cutoff is not a zero-contamination guarantee. Keep a separate high-confidence held-out set for evaluating actual Helix performance. Record provenance, commit date, task creation date, source category and contamination classification. Public tasks must not be the sole evidence of Helix performance.
- **Q7 APPROVED, shared base images:** lightweight immutable base images grouped by language/toolchain; cached repo-specific dependency layers where practical; fresh disposable workspace/container per attempt; the agent never receives hidden grader tests; grader runs in a separate clean environment; custom images only for genuine requirements that cannot fit the shared base.

Constraints: do not download datasets yet; do not implement the HTS harness; no changes to product code, plan, architecture, roadmap, checkboxes or PR #23.

## 9. Not investigated

Individual upstream repo licences; Multi-SWE-bench dataset card text; Harbor internals; ProgramBench; actual task counts per language in the downloaded datasets (not downloaded; read-only, no network data pulls beyond metadata).
