import { test } from 'node:test'
import assert from 'node:assert/strict'
import { architectureSection, buildPacket, parseRoadmap, planRow, selectTasks } from './next-task.mjs'

const roadmap = `# Roadmap
## M0 — Foundations
- [x] **R0.1 Done** (FR-1) [§1]
  - Evidence: ok
## M1 — MVP
- [x] **R1.1 Done task** (FR-1) [§1]
  - Evidence: ok
- [ ] **R1.2 Blocked task** (FR-2) [§2]
  - Blocked: needs runner
- [ ] **R1.3 Stuck task** (FR-2) [§2]
  - Stuck: error X; tried a, b, c
- [ ] **R1.4 Fresh one** (FR-2, SEC-1, F-SBX-2) [§2.1, §3]
  - Accept [A-local]: \`node --test a\` → 1/1
- [ ] **R1.5 Fresh two** (PERF-9) [§3]
  - Accept [A-local]: \`node --test b\` → 1/1
- [ ] **G1.1 Gate** — gate text
## Requirement status (all original IDs)
| ID | Milestone | Status | Audit | Tasks | Gap |
| --- | --- | --- | --- | --- | --- |
| FR-2 | M1 | Partial | RED | R1.4 | gap two |
`

const plan = `- FR-1 First requirement.
- FR-2 Second requirement MUST hold.

| ID | Requirement |
| --- | --- |
| SEC-1 | No host process. |

**F-SBX-2 Whole-toolchain containment**: everything sandboxed. *AC:* red-team passes.
**F-OTHER-1 Next**: other.

| ID | Metric | Budget |
| --- | --- | --- |
| PERF-1 | a | b |
| PERF-9 | Warm start | ≤ 2 s |
`

const architecture = `## 2. Two
intro
### 2.1 Sub one
sub one body
### 2.2 Sub two
sub two body
## 3. Three
three body
`

test('current milestone and task selection skip blocked and stuck items', () => {
  const { current } = parseRoadmap(roadmap)
  assert.equal(current.id, 'M1')
  const { next, stuck, blocked } = selectTasks(current, 2)
  assert.deepEqual(next.map((i) => i.title.split(' (')[0]), ['R1.4 Fresh one', 'R1.5 Fresh two'])
  assert.equal(stuck.length, 1)
  assert.equal(blocked.length, 1)
})

test('plan rows are copied verbatim for list, table and bold formats', () => {
  assert.equal(planRow(plan, 'FR-2'), '- FR-2 Second requirement MUST hold.')
  assert.match(planRow(plan, 'SEC-1'), /\| ID \| Requirement \|\n\| --- \| --- \|\n\| SEC-1 \| No host process\. \|/)
  assert.equal(planRow(plan, 'F-SBX-2'), '**F-SBX-2 Whole-toolchain containment**: everything sandboxed. *AC:* red-team passes.')
  assert.match(planRow(plan, 'PERF-9'), /\| ID \| Metric \| Budget \|[\s\S]*\| PERF-9 \| Warm start/)
  assert.equal(planRow(plan, 'FR-99'), null)
})

test('architecture sections stop at the next heading of the same level', () => {
  assert.equal(architectureSection(architecture, '2.1'), '### 2.1 Sub one\nsub one body')
  assert.equal(architectureSection(architecture, '2'), '## 2. Two\nintro\n### 2.1 Sub one\nsub one body\n### 2.2 Sub two\nsub two body')
  assert.equal(architectureSection(architecture, '9'), null)
})

test('packet contains tasks, cited text, status rows, gates and stuck items', () => {
  const packet = buildPacket({ roadmap, plan, architecture, progress: '## Current task notes\n\n- resume here\n\n## Other\n', count: 2 })
  assert.match(packet, /## Resume notes[\s\S]*- resume here/)
  assert.match(packet, /## Task 1 of 2: R1\.4 Fresh one/)
  assert.match(packet, /## Task 2 of 2: R1\.5 Fresh two/)
  assert.match(packet, /- FR-2 Second requirement MUST hold\./)
  assert.match(packet, /\| FR-2 \| M1 \| Partial/)
  assert.match(packet, /### 2\.1 Sub one\nsub one body/)
  assert.match(packet, /## Open exit gates for M1[\s\S]*G1\.1 Gate/)
  assert.match(packet, /## Stuck tasks[\s\S]*Stuck: error X/)
  assert.doesNotMatch(packet, /R1\.1 Done task/)
})
