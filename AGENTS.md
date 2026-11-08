# Rules for AI build sessions (Helix)

Each session runs on limited credits and may stop at any moment. Optimize for shipping the next task, not for completeness.

## 1. What to read (in this order, nothing else up front)

1. This file.
2. `progress.md` (short by design).
3. Only the `architecture.md` sections named in the current task (use grep for the heading, read just that section).

Do NOT read `plan.md` or `architecture.md` in full. Do NOT read `docs/history/`. Read `docs/decisions.md` only for the component you are changing.

## 2. What to build

- Do the **first unchecked task** in `progress.md`. Nothing else.
- Build the **minimum that passes its "Accept" line**. No extra options, configs, UI extras, refactors, or "while I'm here" improvements.
- If you finish early, start the next unchecked task. Never pick work that is not on the list.
- A good idea that is not on the list → add ONE line to "Ideas parking lot" in `progress.md` and move on.
- If a task turns out bigger than expected, split it into sub-bullets under that task and finish the first one. Do not redesign the plan.
- Prefer simple heuristics over the "full" architecture version (the architecture doc describes the end state, not what M1 needs).

## 3. Save work early (credits can run out)

- Branch: `helix/m1-<task-id>` from `main` (e.g. `helix/m1-t1-egress`).
- Commit and push after each working step, not only at the end.
- Tests: run the focused test file + `npx tsc -p tsconfig.helix.json` while working. Run the full engine suite once, at the end of the task.

## 4. How to update progress.md (strict)

- **Replace, never append.** Tick the checkbox, add at most one short note under the task.
- Overwrite the "Last session" section (max 5 lines). No per-session sections, no logs, no test-count tables.
- Update the "M1 progress: X / 7" line by counting checked boxes.
- Keep the file under 150 lines. Detailed history belongs in commit messages and PR descriptions.
- New decisions or bugs → one line in `docs/decisions.md`.

## 5. Finish the session

Before stopping: push the branch, make sure `progress.md` says exactly which task/sub-step is next, and open a PR to `main`.
