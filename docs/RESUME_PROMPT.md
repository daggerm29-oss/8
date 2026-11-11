# Universal resume prompt

Paste this exact text into any new session (any account, any model). It is the same every time; all state lives in the repository.

```text
Resume Helix. Follow AGENTS.md exactly; it is the only rulebook.
1. Run `gh pr list --state open` and check out the branch AGENTS.md §3 selects (git pull).
2. Run `node scripts/next-task.mjs` and read CURRENT_TASK.md. Do not read plan.md, architecture.md, docs/roadmap.md or progress.md in full — the packet already contains the parts you need.
3. Build the tasks in CURRENT_TASK.md in order. Target 3–5 completed tasks this session. Obey the budget rules in AGENTS.md §1a (quiet.mjs for every test/build/CI command, 3-attempt stuck rule, commit + push after every working step).
4. After each task: AGENTS.md §4, then rerun `node scripts/next-task.mjs` and continue.
Never merge, never change scope, never start the next milestone on this PR.
```
