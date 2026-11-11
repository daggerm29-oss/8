# Rules for AI build sessions (Helix)

Each session runs on limited credits (about $5) and may stop at any moment. Spend them on building, not on reading or log output: target **3–5 completed roadmap tasks per session**, in roadmap order, saving and reporting after every task. The budget rules in §1a are how that target is reached; they never reduce scope. These rules apply to every milestone (M0 through M6). The same resume prompt (`docs/RESUME_PROMPT.md`) starts every session.

## 0. Authority (read first)

| Document | Defines | Precedence |
|---|---|---|
| `plan.md` | WHAT to build: requirements, acceptance criteria, milestone scope and exit criteria | 1 (wins every conflict) |
| `architecture.md` | HOW the complete system works | 2 |
| `docs/roadmap.md` | HOW scope is divided into tasks, and each task's Accept command | 3 |
| `AGENTS.md` (this file) | HOW sessions execute tasks | 4 |

- The roadmap is a work breakdown, not the scope. If a task looks narrower than the requirement it cites, the requirement still applies in full. The task delivers an increment and the requirement stays **Partial** until its original acceptance criterion passes (plan §0.3).
- Never remove, narrow, merge away, or indefinitely defer a requirement, task, or exit gate. Never move an item to a later milestone. Never reverse a reject verdict (X19–X21). Those are scope changes, and only the user can approve them (plan §0.3, change log).
- If documents conflict, follow the higher-precedence one, note the conflict in `docs/decisions.md`, and mention it in your next update.

## 1. What to read (in this order, nothing else up front)

1. This file.
2. Run `gh auth status >/dev/null 2>&1; node scripts/next-task.mjs` and read the generated `CURRENT_TASK.md` (gitignored, ~4k tokens). It copies verbatim: the latest branch CI result with filtered failure lines, the progress.md resume notes, the next 3 open tasks of the current milestone with their Accept lines, the `plan.md` rows for every requirement ID they cite, their requirement status rows, the `architecture.md` sections in their brackets, the milestone's open exit gates, and any Stuck/Blocked tasks.
3. Only if the packet says a section was truncated or not found, or you need a detail it lacks, grep that one item in the source file and read just those lines.

Do not read `plan.md`, `architecture.md`, `docs/roadmap.md` or `progress.md` in full — the packet replaces that reading, and the source files stay authoritative (§0). Do not read `docs/history/`. Read `docs/decisions.md` only for the component you are changing (grep it).

## 1a. Budget rules (how 3–5 tasks fit in one session)

- **Quiet output.** Run every test, build, typecheck, install and CI-log command through `node scripts/quiet.mjs "<command>"`. It saves the full log under `/tmp/helix-logs/` and prints only the exit code, failure lines and the last 40 lines. Read the full log only with a targeted grep or line range. Copy it into `evals/results/` when it is evidence.
- **Small reads.** Read source files by grep plus line ranges, not whole large files. Never print lockfiles, generated files, `dist/` or `node_modules/`.
- **Stuck rule.** If the same failure survives 3 genuinely different fix attempts, stop that task: leave it unticked, write `  - Stuck: <exact failure>; tried <1>, <2>, <3>; next idea <x>` under it, commit, push, and move to the next task. This is not a deferral or scope change — the task stays open, and `next-task.mjs` lists it under Stuck for a later session.
- **CI failures.** Start from `node scripts/quiet.mjs "gh run view <id> --log-failed"`, not from re-running the whole pipeline. Rebuild packaged Electron only when the task or failure requires it.
- **No re-reading.** After a task, rerun `node scripts/next-task.mjs` instead of re-reading documents. Don't re-open files you already have in context.
- **Short updates.** Per-task update is the one line in §4 step 6. No restating plans or recaps between steps.

## 2. What to build

- Work through the roadmap **in order**: the "Next task" in the `progress.md` dashboard (= first unchecked top-level item of the current milestone), then the next one. Nothing off the list.
- Every task names the requirement IDs it serves, the architecture sections it implements, and one **Accept** command with its expected result. If a task has no Accept line, write one first (description + IDs + command + expected result), then build it.
- Build what the task's Accept line requires, following the cited architecture design. Keep each task small, but do not swap the specified design for a simpler one. A simpler intermediate step is allowed only if the task says so explicitly; it never completes the requirement.
- No unrelated options, refactors, or "while I'm here" changes. A good idea outside the roadmap goes in one line in "Ideas parking lot" in `progress.md`.
- You may split a big task into indented sub-bullets (not counted). You may not reword a top-level item so it asks for less.
- **Adding tasks:** if you find an original requirement (or part of one) that no roadmap task covers, add a top-level task for it in the milestone plan §12 assigns, cite the IDs, and say so in the PR. Adding coverage is not a scope change; removing it is.
- **One PR never spans two milestones.** When the current milestone reaches 100% of its tasks, stop building on this branch and end the session (section 5) so the user can review and merge. The next session starts the next milestone on a fresh branch from `main`.
- **Verification classes** (architecture §35.1): run A-local Accept commands yourself. A-host, A-ref, and A-live commands need a CI runner, reference hardware, or provider keys. If they are unavailable, build the task and its harness, run every A-local part, leave the box unticked, write `  - Blocked: needs <runner/keys>; A-local parts pass (<command> → <result>)` under it, and continue with the next task. Never substitute a fake provider, synthetic fixture, or smaller run for the stated command.
- **Exit gates:** a milestone is complete only when its tasks are done **and** its exit gates pass. Automated gates (evals, benchmarks, red-team, PERF) are build work: run them and record evidence. External gates (real user studies, design partners, independent pen tests, audits) cannot be done by a session. Leave them open and list them in the session summary. Never report a mocked, simulated, or self-run result as passing an external gate.

## 3. Session branch and PR (one session = one batch = one PR)

- **Start of session:** run `gh pr list --state open`.
  - If an open `helix/session-*` PR exists, the user has not merged it yet: check out that branch, `git pull`, and continue on it. Never start from `main` while unmerged work exists.
  - If that open PR's milestone tasks are already 100% (per `node scripts/progress.mjs` on its branch), do not add tasks from the next milestone to it. Only finish fixes requested in its review comments, then end the session (section 5) and ask the user to merge it.
  - If more than one open `helix/session-*` PR exists, continue the one whose base is `main`; never touch a PR stacked on another branch.
  - Never continue an open PR whose milestone is later than the current milestone (the first milestone with unticked tasks). Leave it as a draft; its work is reused when that milestone starts (example: draft PR #19 for M3 is parked while M0–M2 restoration tasks are open).
  - Otherwise create `helix/session-<YYYY-MM-DD>-<next-task-short-name>` from the latest `main`.
- **Immediately after your first push** (even if the first task is unfinished): open ONE **draft** PR to `main` for the session branch. Later work pushes to the same branch and PR. Never open a PR per task.
- Commit and push after every working step, not only at the end of a task.
- **Never merge your own PR.** The user reviews and merges.
- Tests: for each task, run its focused test file(s) and `npx tsc -p tsconfig.helix.json` (plus the task's Accept command, section 4). Do **not** run the full engine suite after each task. Run it **once per session**, at the end, immediately before the SESSION SUMMARY (section 5).

## 4. After EVERY completed task (strict)

1. Actually run the task's Accept command. Tick the item (`- [ ]` → `- [x]`) only if the result matches the expected result. Never tick based on implementation alone.
2. Directly under the ticked item add: `  - Evidence: <command you ran> → <actual result>; commit <sha>; artifact <path, if any>`. The script does not count ticks without it.
3. Update the task's requirement IDs in the requirement status table in `docs/roadmap.md`: set **Done** only if the full original acceptance criterion in `plan.md` now passes with evidence, and replace its gap cell with `Evidence: <command> → <result>; commit <sha>`; otherwise keep **Partial** and shorten the gap to what is still missing. For a split row (milestone cell names several milestones), record a finished part as `M<n> part: Evidence: <command> → <result>; commit <sha>` and set Done only when the last part passes.
4. Run `node scripts/progress.mjs` (rewrites the dashboard in `progress.md`). Never type percentages by hand.
5. Commit and push. Update the PR description's task list.
6. Post a short update: `Done: <task> — Evidence: <command> → <result> — Checklist: Overall x% | M0 x% | … | M6 x% — Requirements Done: <n>/154`. Then continue with the next task.

Other progress rules:

- Percentages are **task checklist completion**. They are not requirement completion, product quality, or release readiness. Always say so when you report them, and report requirement status separately.
- Never delete roadmap items, exit gates, or requirement rows.
- In `progress.md`, **replace, never append**: overwrite "Current task notes" and "Last session" (max 5 lines each). No per-session logs. Keep it under 120 lines.
- New decisions or bugs → one line in `docs/decisions.md`. A deviation from `architecture.md` needs an `IMPL-ADR` that names the roadmap task closing the gap.

## 5. Ending the session (credits low, or you are about to stop) — required

- If a task is unfinished: leave its box unticked, push, and write in "Current task notes" exactly where to resume (file, function, next step).
- Run the full engine suite once (command in `progress.md` "How to run", timeout ≥ 600 s). If anything fails, fix it or record it under Unfinished and set `Safe to merge: no`. Put the result in "Last session".
- One PR covers the entire milestone. Continue the existing branch and open PR while the milestone is unfinished; a session or individual task ending is not a merge checkpoint. Keep it open and unmerged, and do not create another branch or PR per task.
- Request completion review/merge and mark the PR ready (`gh pr ready`) only when milestone task completion is 100% and its applicable automated exit gates pass. Until then, report `ACTION NEEDED: none — continue this milestone on the existing branch/PR` and `Safe to merge: no — milestone unfinished` (or the concrete failing gate). External gates remain explicitly open as required above.
- Run `node scripts/progress.mjs`, then end your reply with this block:

```
SESSION SUMMARY
Completed this session: <task> (evidence: <command> → <result>); <task> (...)
Unfinished: <task — where to resume>   (or: none)
Full engine suite (once, at session end): <command> → <passed>/<total>
Requirements changed: <ID → Partial/Done>; ...   (or: none)
Open exit gates for this milestone: <automated: ...> | <external: ...>
ACTION NEEDED: none — continue this milestone on the existing branch/PR: <PR URL> (at 100% tasks + passing applicable automated gates only: completion review/merge)
Safe to merge: no — milestone unfinished (or, only at the completion checkpoint: yes)
Checklist completion (progress.md, tasks only): Overall <x>% | M0 <x>% | M1 <x>% | M2 <x>% | M3 <x>% | M4 <x>% | M5 <x>% | M6 <x>%
Next task: <next task name>
```

Copy the percentages from the script output. If the session is cut off before this block, the draft PR and "Current task notes" let the next session resume (section 3).
