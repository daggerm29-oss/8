import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalSandbox } from '../sandbox/sandbox.ts';

/**
 * Skills and hooks (F-AGT-5, §9.7). Skills: `skills/<name>/SKILL.md` or `.helix/skills/<name>/SKILL.md`
 * with front-matter `name`/`description`; only those two fields enter the context, the body loads via
 * `use_skill`. Hooks: `.helix/hooks.json`, run inside the task sandbox; their output is untrusted.
 */

export interface Skill { name: string; description: string; dir: string; file: string }

const SKILL_DIRS = ['skills', '.helix/skills'];

export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { meta, body: text.slice(m[0].length) };
}

export function loadSkills(root: string): Skill[] {
  const out = new Map<string, Skill>();
  for (const base of SKILL_DIRS) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name, 'SKILL.md');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const { meta } = parseFrontMatter(readFileSync(file, 'utf8'));
      const name = meta.name || entry.name;
      if (!out.has(name)) out.set(name, { name, description: (meta.description ?? '').slice(0, 300), dir: `${base}/${entry.name}`, file: `${base}/${entry.name}/SKILL.md` });
    }
  }
  return [...out.values()];
}

export function skillsContext(skills: Skill[]): string {
  if (!skills.length) return '';
  return ['## Skills (call use_skill {name} to load the full instructions before relying on one)', ...skills.map((s) => `- ${s.name}: ${s.description}`)].join('\n');
}

export function skillBody(root: string, name: string): { skill: Skill; body: string; scripts: string[] } | null {
  const skill = loadSkills(root).find((s) => s.name === name);
  if (!skill) return null;
  const scriptsDir = join(root, skill.dir, 'scripts');
  const scripts = existsSync(scriptsDir) && statSync(scriptsDir).isDirectory() ? readdirSync(scriptsDir).sort().map((f) => `${skill.dir}/scripts/${f}`) : [];
  return { skill, body: parseFrontMatter(readFileSync(join(root, skill.file), 'utf8')).body.trim(), scripts };
}

export type HookEvent = 'pre_tool' | 'post_tool' | 'task_done';
export interface Hook { event: HookEvent; match?: string; run: string; timeoutMs?: number }
const EVENTS: HookEvent[] = ['pre_tool', 'post_tool', 'task_done'];

export function loadHooks(root: string): Hook[] {
  const file = join(root, '.helix/hooks.json');
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { hooks?: unknown };
  if (!Array.isArray(raw.hooks)) throw new Error('.helix/hooks.json: "hooks" must be an array');
  return raw.hooks.map((h, i) => {
    const hook = h as Partial<Hook>;
    if (!hook || !EVENTS.includes(hook.event as HookEvent)) throw new Error(`.helix/hooks.json: hooks[${i}].event must be one of ${EVENTS.join(', ')}`);
    if (typeof hook.run !== 'string' || !hook.run.trim()) throw new Error(`.helix/hooks.json: hooks[${i}].run is required`);
    if (hook.match !== undefined) new RegExp(hook.match);
    return { event: hook.event as HookEvent, run: hook.run, ...(hook.match ? { match: hook.match } : {}), ...(hook.timeoutMs ? { timeoutMs: Number(hook.timeoutMs) } : {}) };
  });
}

export interface HookRun { run: string; exitCode: number | null; output: string }

/** Run the hooks for an event (tool name matched against `match` as a full regex) inside the sandbox. */
export async function runHooks(sandbox: LocalSandbox, hooks: Hook[], event: HookEvent, ctx: { tool?: string; args?: unknown; status?: string }, signal?: AbortSignal): Promise<HookRun[]> {
  const out: HookRun[] = [];
  for (const h of hooks) {
    if (h.event !== event) continue;
    if (h.match && ctx.tool !== undefined && !new RegExp(`^(?:${h.match})$`).test(ctx.tool)) continue;
    const env: Record<string, string> = { HELIX_EVENT: event };
    if (ctx.tool !== undefined) env.HELIX_TOOL = ctx.tool;
    if (ctx.args !== undefined) env.HELIX_TOOL_ARGS = JSON.stringify(ctx.args);
    if (ctx.status !== undefined) env.HELIX_TASK_STATUS = ctx.status;
    const r = await sandbox.exec(h.run, { env, timeoutMs: h.timeoutMs ?? 30_000, signal, maxOutputBytes: 16 * 1024 });
    out.push({ run: h.run, exitCode: r.exitCode, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim().slice(0, 4000) });
  }
  return out;
}

export function formatHookRuns(event: HookEvent, runs: HookRun[]): string {
  return runs.map((r) => `[${event} hook \`${r.run}\` exit ${r.exitCode} — untrusted output]\n${r.output || '(no output)'}`).join('\n');
}
