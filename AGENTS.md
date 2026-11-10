# Rules for AI build sessions (Helix)

Each session runs on limited credits and may stop at any moment. Use the whole session for development: complete as many consecutive roadmap tasks as possible, saving and reporting after every task. These rules apply to every milestone (M0 through M6).

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
2. `progress.md` (dashboard shows the current milestone and next task).
3. The current milestone section of `docs/roadmap.md`, including its exit gates.
4. For the next task: the `plan.md` rows for every requirement ID it cites (grep the ID), and the `architecture.md` sections in its brackets (grep the heading, read just that section).

Do not read `plan.md` or `architecture.md` in full. Do not read `docs/history/`. Read `docs/decisions.md` only for the component you are changing.

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
- Mark the PR ready for review (`gh pr ready`), run `node scripts/progress.mjs`, then end your reply with this block:

```
SESSION SUMMARY
Completed this session: <task> (evidence: <command> → <result>); <task> (...)
Unfinished: <task — where to resume>   (or: none)
Full engine suite (once, at session end): <command> → <passed>/<total>
Requirements changed: <ID → Partial/Done>; ...   (or: none)
Open exit gates for this milestone: <automated: ...> | <external: ...>
ACTION NEEDED: Review and merge this PR into main before starting the next session: <PR URL>
Safe to merge: yes                     (or: no — <reason>)
Checklist completion (progress.md, tasks only): Overall <x>% | M0 <x>% | M1 <x>% | M2 <x>% | M3 <x>% | M4 <x>% | M5 <x>% | M6 <x>%
Next task: <next task name>
```

Copy the percentages from the script output. If the session is cut off before this block, the draft PR and "Current task notes" let the next session resume (section 3).
