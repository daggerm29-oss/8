# Universal resume prompt

Paste this exact text into any new session (any account, any model). It is the same every time; all state lives in the repository.

```text
Resume Helix from the GitHub repository; do not rely on earlier chat history. Follow AGENTS.md for workflow and execution, and keep its §0 authority order: plan.md defines product scope, architecture.md defines design, docs/roadmap.md defines tasks and acceptance.
1. Run `git status`. If the tree is dirty (an earlier session died mid-step), review `git diff --stat`, then commit the work as `wip: <task>` and push if it belongs to the current task, otherwise `git stash`; say which you did. Then run `gh pr list --state open`, check out the branch AGENTS.md §3 selects, and `git pull --ff-only`. If the branch is ambiguous or the pull is not a fast-forward, stop and report.
2. Run `gh auth status >/dev/null 2>&1; node scripts/next-task.mjs` (the gh call loads GitHub credentials so the packet includes the latest CI failure) and read CURRENT_TASK.md. Do not read plan.md, architecture.md, docs/roadmap.md or progress.md in full — the packet already contains the parts you need.
3. Build only what each task's requirements and Accept command need: no extra features, abstractions, refactors, dependencies or docs. Put any other idea as one line in progress.md "Ideas parking lot" and move on (AGENTS.md §2). Build the tasks in CURRENT_TASK.md in order. Target 3–5 completed tasks this session, but never skip or weaken an Accept command to reach it. Obey the budget rules in AGENTS.md §1a (quiet.mjs for every test/build/CI command, 3-attempt Stuck rule, commit + push after every working step).
4. After each task: AGENTS.md §4, then rerun `node scripts/next-task.mjs` and continue. Stuck tasks are excluded from the queue automatically; retry one only when the packet has no fresh tasks or its Stuck note's blocker is resolved (then delete the Stuck line).
Never merge, never remove or weaken a requirement, task or exit gate, never start the next milestone on this PR. When the milestone's exit gates pass, mark the PR ready for review and stop.
```
