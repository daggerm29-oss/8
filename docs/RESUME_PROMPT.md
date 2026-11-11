# Universal resume prompt

Paste this exact text into any new session (any account, any model). It is the same every time; all state lives in the repository.

```text
Resume Helix. Follow AGENTS.md for workflow and execution, and keep its §0 authority order: plan.md defines product scope, architecture.md defines design, docs/roadmap.md defines tasks and acceptance.
1. Run `gh pr list --state open` and check out the branch AGENTS.md §3 selects (git pull).
2. Run `gh auth status >/dev/null 2>&1; node scripts/next-task.mjs` (the gh call loads GitHub credentials so the packet includes the latest CI failure) and read CURRENT_TASK.md. Do not read plan.md, architecture.md, docs/roadmap.md or progress.md in full — the packet already contains the parts you need.
3. Build the tasks in CURRENT_TASK.md in order. Target 3–5 completed tasks this session. Obey the budget rules in AGENTS.md §1a (quiet.mjs for every test/build/CI command, 3-attempt stuck rule, commit + push after every working step).
4. After each task: AGENTS.md §4, then rerun `node scripts/next-task.mjs` and continue.
Never merge, never change scope, never start the next milestone on this PR.
```
