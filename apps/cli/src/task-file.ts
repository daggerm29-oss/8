import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { TaskCreateParams } from '@helix/protocol';

export function loadTaskFile(path: string): TaskCreateParams {
  const filename = resolve(path);
  const document = parseDocument(readFileSync(filename, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`invalid task YAML: ${document.errors[0].message}`);
  const data: unknown = document.toJS({ maxAliasCount: 20 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('task YAML must be an object');
  const task = data as Record<string, unknown>;
  const allowed = new Set(['goal', 'workspacePath', 'title', 'provider', 'model', 'verifyCommand', 'maxSteps', 'budgetUsd', 'policyProfile', 'preapprove', 'roles']);
  for (const key of Object.keys(task)) if (!allowed.has(key)) throw new Error(`unknown task field: ${key}`);
  for (const key of ['goal', 'workspacePath', 'title', 'provider', 'model', 'verifyCommand']) {
    if (task[key] !== undefined && typeof task[key] !== 'string') throw new Error(`${key} must be a string`);
  }
  if (typeof task.goal !== 'string' || !task.goal.trim()) throw new Error('task goal is required');
  if (task.maxSteps !== undefined && (!Number.isSafeInteger(task.maxSteps) || Number(task.maxSteps) <= 0)) throw new Error('maxSteps must be a positive integer');
  if (task.budgetUsd !== undefined && (typeof task.budgetUsd !== 'number' || !Number.isFinite(task.budgetUsd) || task.budgetUsd < 0)) throw new Error('budgetUsd must be nonnegative and finite');
  if (task.policyProfile !== undefined && !['headless', 'plan'].includes(String(task.policyProfile))) throw new Error('helix run requires headless or plan policy');
  if (task.preapprove !== undefined && (!Array.isArray(task.preapprove) || task.preapprove.some((v) => typeof v !== 'string'))) throw new Error('preapprove must be a list of strings');
  if (task.roles !== undefined && (!task.roles || typeof task.roles !== 'object' || Array.isArray(task.roles))) throw new Error('roles must be an object');
  return { ...task, goal: task.goal, workspacePath: resolve(dirname(filename), String(task.workspacePath ?? '.')), policyProfile: task.policyProfile === 'plan' ? 'plan' : 'headless' } as TaskCreateParams;
}
