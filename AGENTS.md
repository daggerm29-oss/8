# Rules for AI build sessions (Helix)

Each session runs on limited credits and may stop at any moment. Optimize for shipping the next task, not for completeness. These rules apply to every milestone (M1 through M6).

## 1. What to read (in this order, nothing else up front)

1. This file.
2. `progress.md` (dashboard shows the current milestone and next task).
3. The current milestone section of `docs/roadmap.md`.
4. Only the `architecture.md` sections named in the task brackets (grep the heading, read just that section).

Do NOT read `plan.md` or `architecture.md` in full. Do NOT read `docs/history/`. Read `docs/decisions.md` only for the component you are changing.

## 2. What to build

- Do the **"Next task"** shown in the `progress.md` dashboard (= first unchecked top-level item of the current milestone in `docs/roadmap.md`). Nothing else.
- If the task has no "Accept:" line yet (later milestones), first write a short description + one Accept line for it in `docs/roadmap.md`, then build it.
- Build the **minimum that passes its Accept line**. No extra options, configs, UI extras, refactors, or "while I'm here" improvements.
- If you finish early and have credits left, report the task (section 5), then continue with the next one on a new branch.
- Never add, remove, or reword top-level roadmap items (that would fake the percentages). A big task may be split into indented sub-bullets under it; sub-bullets are not counted.
- A good idea that is not on the roadmap → one line in "Ideas parking lot" in `progress.md`, then move on.
- Prefer simple heuristics over the "full" architecture version (the architecture doc describes the end state).
- When the current milestone hits 100%, the next milestone automatically becomes current. Human launch gates are not build tasks; skip them.

## 3. Save work early (credits can run out)

- Branch from the latest `main`: `helix/<milestone>-<short-task-name>` (e.g. `helix/m1-egress`, `helix/m2-tree-sitter`).
- Commit and push after each working step, not only at the end.
- Tests: focused test file + `npx tsc -p tsconfig.helix.json` while working; full engine suite once at the end of the task.

## 4. Updating progress (strict)

- Tick the item in `docs/roadmap.md` (`- [ ]` → `- [x]`) only when its Accept line passes.
- Then run `node scripts/progress.mjs`. It rewrites the dashboard in `progress.md`. Never type percentages by hand.
- In `progress.md`, **replace, never append**: overwrite "Current task notes" and "Last session" (max 5 lines each). No per-session sections, logs, or test-count tables. Keep it under 120 lines.
- New decisions or bugs → one line in `docs/decisions.md`.

## 5. End of every task or session — tell the user (required)

Push the branch, open a PR to `main`, run `node scripts/progress.mjs`, then end your reply with this block, filled in:

```
TASK COMPLETE: <task name>            (or: TASK PARTIAL: <task name> — <what is left>)
ACTION NEEDED: Merge this PR into main before starting the next session: <PR URL>
Safe to merge: yes                   (or: no — <reason>)
Progress (see progress.md): Overall <x>% | M1 <x>% | M2 <x>% | M3 <x>% | M4 <x>% | M5 <x>% | M6 <x>%
Next task: <next task name>
```

Copy the percentages from the script output. If the task is partial, leave the box unticked and write exactly where to resume in "Current task notes".
