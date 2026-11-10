#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineCommit = 'f4742348efe912d2188dbc28a260aca32d391577';
const requirementPattern = /\b(?:FR-\d+|F-[A-Z]+-\d+|NFR-\d+|SEC-\d+|PERF-\d+)\b/g;
const taskPattern = /\b(?:R\d+\.\d+|G\d+\.\d+)\b/g;
const clean = (value) => value.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
const gitFile = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

export function requirementRows(text) {
  return text.split('\n').filter((line) => /^\| (?:FR-\d+|F-[A-Z]+-\d+|NFR-\d+|SEC-\d+|PERF-\d+) \|/.test(line)).map((line) => {
    const [id, milestone, status, audit, tasks, ...gap] = line.slice(2, -2).split(' | ');
    return { id, milestone, status, audit, tasks, gap: gap.join(' | ') };
  });
}

function roadmapItems(text) {
  let milestone;
  const items = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (M\d+) [—-]/);
    if (heading) milestone = heading[1];
    const box = line.match(/^- \[([ xX])\] (.+)$/);
    if (box) items.push({ milestone, ticked: box[1] !== ' ', title: clean(box[2]), key: `${milestone}:${clean(box[2])}`, evidence: false });
    else if (/^\s+- Evidence:\s*\S/.test(line) && items.length) items.at(-1).evidence = true;
  }
  return items;
}

function changeLog(plan) {
  return (plan.match(/\*\*Scope change log\*\*([\s\S]*?)(?:\n---|\n## )/)?.[1] ?? '').split('\n').filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
}

export function checkScope({ roadmap, plan, baselinePlan, mainRoadmap, mainPlan, milestone }) {
  const errors = [];
  const expected = new Set(baselinePlan.match(requirementPattern));
  const rows = requirementRows(roadmap);
  const ids = new Set(rows.map((r) => r.id));
  if (expected.size !== 154) errors.push(`authoritative baseline contains ${expected.size}, not 154 IDs`);
  if (rows.length !== 154 || ids.size !== 154 || [...expected].some((id) => !ids.has(id)) || [...ids].some((id) => !expected.has(id))) errors.push(`requirement set mismatch: ${rows.length} rows / ${ids.size} unique; missing ${[...expected].filter((id) => !ids.has(id)).join(', ')}; unexpected ${[...ids].filter((id) => !expected.has(id)).join(', ')}`);
  const items = roadmapItems(roadmap);
  const definitions = new Map(items.flatMap((item) => {
    const id = item.title.match(/^(R\d+\.\d+|G\d+\.\d+)\b/)?.[1];
    return id ? [[id, item]] : [];
  }));
  const duplicateDefinitions = items.filter((item) => /^(R\d+\.\d+|G\d+\.\d+)\b/.test(item.title)).length - definitions.size;
  if (duplicateDefinitions) errors.push(`${duplicateDefinitions} duplicate task definitions`);
  let undefinedRefs = 0;
  for (const row of rows) {
    const milestones = [...row.milestone.matchAll(/M(\d+)/g)].map((m) => Number(m[1]));
    const last = Math.max(...milestones);
    for (const ref of row.tasks.match(taskPattern) ?? []) {
      const task = definitions.get(ref);
      if (!task) { undefinedRefs++; errors.push(`${row.id}: undefined task ${ref}`); }
      else if (Number(task.milestone.slice(1)) > last) errors.push(`${row.id}: ${ref} is later than every milestone in ${row.milestone}`);
    }
    if (row.status === 'Done' && !/Evidence:\s*\S/.test(row.gap)) errors.push(`${row.id}: Done without evidence`);
    if (milestone && milestones.includes(Number(milestone.slice(1)))) {
      if (milestones.length === 1 || last === Number(milestone.slice(1))) {
        if (row.status !== 'Done' || !/Evidence:\s*\S/.test(row.gap)) errors.push(`${row.id}: ${milestone} requirement not Done with evidence`);
      } else if (!row.gap.includes(`${milestone} part: Evidence:`)) errors.push(`${row.id}: missing ${milestone} part: Evidence:`);
    }
  }
  const unproven = items.filter((item) => item.ticked && !item.evidence);
  for (const item of unproven) errors.push(`ticked without evidence: ${item.key}`);
  const changes = changeLog(plan).filter((line) => !changeLog(mainPlan).includes(line));
  const approved = (subject) => changes.some((line) => {
    const cells = line.slice(2, -2).split(' | ');
    return cells.length >= 5 && cells.every((cell) => cell.trim() && cell !== '—') && /user|approved/i.test(cells[4]) && (clean(cells[1]).split(/[,;]\s*/).some((id) => subject.includes(id)) || clean(cells[2]).includes(subject));
  });
  const currentKeys = new Set(items.map((item) => item.key));
  const removed = roadmapItems(mainRoadmap).filter((item) => !currentKeys.has(item.key) && !approved(item.title));
  for (const item of removed) errors.push(`removed roadmap item without scope change: ${item.key}`);
  const gates = (text) => [...text.matchAll(/^\| (X-M\d+\.\d+) \|/gm)].map((m) => m[1]);
  for (const gate of gates(mainRoadmap)) if (!gates(roadmap).includes(gate) && !approved(gate)) { removed.push({ key: gate }); errors.push(`removed external exit gate: ${gate}`); }
  for (const before of requirementRows(mainRoadmap)) {
    const after = rows.find((r) => r.id === before.id);
    if (!after) continue;
    const first = (cell) => Math.min(...[...cell.matchAll(/M(\d+)/g)].map((m) => Number(m[1])));
    if (first(after.milestone) > first(before.milestone) && !approved(before.id)) errors.push(`${before.id}: earliest milestone postponed without approval`);
  }
  for (const id of ['X19', 'X20', 'X21']) {
    const verdict = (text) => text.split('\n').find((line) => new RegExp(`^\\| ${id} \\|`).test(line));
    if (verdict(plan) !== verdict(baselinePlan) && !approved(id)) errors.push(`${id}: rejected baseline verdict changed`);
  }
  return { errors, summary: `${ids.size}/154 IDs, ${undefinedRefs} undefined task refs, ${unproven.length} ticks without evidence, ${removed.length} removed items`, done: rows.filter((r) => r.status === 'Done').length };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, 'base-ref': { type: 'string', default: 'refs/remotes/origin/main' }, milestone: { type: 'string' } } });
    if (values.milestone && !/^M[0-6]$/.test(values.milestone)) throw new Error('--milestone must be M0..M6');
    const root = resolve(values.root ?? repository);
    const result = checkScope({ roadmap: readFileSync(join(root, 'docs/roadmap.md'), 'utf8'), plan: readFileSync(join(root, 'plan.md'), 'utf8'), baselinePlan: gitFile(baselineCommit, 'plan.md'), mainRoadmap: gitFile(values['base-ref'], 'docs/roadmap.md'), mainPlan: gitFile(values['base-ref'], 'plan.md'), milestone: values.milestone });
    console.log(result.summary);
    for (const error of result.errors) console.error(error);
    console.log(`Requirements Done: ${result.done}/154`);
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) { console.error(`scope check unavailable: ${error.message}`); process.exitCode = 1; }
}
