# Rules for AI build sessions (Helix)

Each session runs on limited credits and may stop at any moment. Use the whole session for development: complete as many consecutive roadmap tasks as possible, saving and reporting after every task. These rules apply to every milestone (M1 through M6).

## 1. What to read (in this order, nothing else up front)

1. This file.
2. `progress.md` (dashboard shows the current milestone and next task).
3. The current milestone section of `docs/roadmap.md`.
4. Only the `architecture.md` sections named in the task brackets (grep the heading, read just that section).

Do NOT read `plan.md` or `architecture.md` in full. Do NOT read `docs/history/`. Read `docs/decisions.md` only for the component you are changing.

## 2. What to build

- Work through the roadmap **in order**: the "Next task" in the `progress.md` dashboard (= first unchecked top-level item of the current milestone in `docs/roadmap.md`), then the next one, and so on. Nothing off the list.
- If a task has no "Accept:" line yet (later milestones), first write a short description + one Accept line for it in `docs/roadmap.md`, then build it.
- Build the **minimum that passes its Accept line**. No extra options, configs, UI extras, refactors, or "while I'm here" improvements.
- Never add, remove, or reword top-level roadmap items (that would fake the percentages). A big task may be split into indented sub-bullets under it; sub-bullets are not counted.
- A good idea that is not on the roadmap → one line in "Ideas parking lot" in `progress.md`, then move on.
- Prefer simple heuristics over the "full" architecture version (the architecture doc describes the end state).
- When the current milestone hits 100%, continue with the next milestone. Human launch gates are not build tasks; skip them.

## 3. Session branch and PR (one session = one batch = one PR)

- **Start of session:** run `gh pr list --state open`.
  - If an open `helix/session-*` PR exists, the user has not merged it yet: check out that branch, `git pull`, and continue on it. Never start from `main` while unmerged work exists.
  - Otherwise create `helix/session-<YYYY-MM-DD>-<next-task-short-name>` from the latest `main`.
- **After the first completed task:** open ONE **draft** PR to `main` for the session branch. Later tasks push to the same branch/PR. Never open a PR per task.
- Commit and push after every working step, not only at the end of a task (credits can run out at any moment).
- **Never merge your own PR.** The user reviews and merges.
- Tests: focused test file + `npx tsc -p tsconfig.helix.json` while working; full engine suite once at the end of each task.

## 4. After EVERY completed task (strict)

1. Actually run the check in its Accept line. Tick the item in `docs/roadmap.md` (`- [ ]` → `- [x]`) only if it passed. Never tick based on implementation alone.
2. Directly under the ticked item add: `  - Evidence: <command you ran> → <actual result>; commit <sha>; artifact <path, if any>`. The script does not count ticks without it.
3. Run `node scripts/progress.mjs` (rewrites the dashboard in `progress.md`). Never type percentages by hand.
4. Commit and push. Update the PR description's task list.
5. Post a short update to the user: `Done: <task> — Evidence: <command> → <result> — Checklist: Overall x% | M0 x% | M1 x% | M2 x% | M3 x% | M4 x% | M5 x% | M6 x%`. Then continue with the next task.

Other progress rules:

- Never delete roadmap items, "(deferred from M1)" tags, or human launch gates. Percentages are checklist completion, not product quality or release readiness; say so if you report them.
- In `progress.md`, **replace, never append**: overwrite "Current task notes" and "Last session" (max 5 lines each). No per-session sections, logs, or test-count tables. Keep it under 120 lines.
- New decisions or bugs → one line in `docs/decisions.md`.

## 5. Ending the session (credits low, or you are about to stop) — required

- If a task is unfinished: leave its box unticked, push, and write in "Current task notes" exactly where to resume (file, function, next step).
- Mark the PR ready for review (`gh pr ready`), run `node scripts/progress.mjs`, then end your reply with this block:

```
SESSION SUMMARY
Completed this session: <task> (evidence: <command> → <result>); <task> (...)
Unfinished: <task — where to resume>   (or: none)
ACTION NEEDED: Review and merge this PR into main before starting the next session: <PR URL>
Safe to merge: yes                     (or: no — <reason>)
Checklist completion (progress.md): Overall <x>% | M0 <x>% | M1 <x>% | M2 <x>% | M3 <x>% | M4 <x>% | M5 <x>% | M6 <x>%
Next task: <next task name>
```

Copy the percentages from the script output. If the session is cut off before this block, the draft PR and "Current task notes" still let the next session resume (section 3).
