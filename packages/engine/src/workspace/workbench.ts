import {
  DEFAULT_WORKBENCH_KEYS,
  WORKBENCH_PANELS,
  WORKBENCH_PROFILES,
  fuzzyScore,
  type WorkbenchSettings,
  type PaletteEntry,
} from "@helix/protocol";
import type { Db } from "../storage/db.ts";
import { listWorkspaceFiles } from "./files.ts";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validateLayout(layout: unknown): asserts layout is object {
  if (!record(layout) || JSON.stringify(layout).length > 131072)
    throw new Error("Invalid layout size");
  if (!record(layout.layout) || layout.layout.type !== "row")
    throw new Error("Layout needs a root row");
  const ids = new Set<string>();
  const panels = new Set<string>();
  let count = 0;
  function visit(value: unknown, depth: number, parent: string) {
    if (!record(value) || ++count > 200 || depth > 12)
      throw new Error("Invalid layout tree");
    const type = value.type;
    if (!["row", "tabset", "tab"].includes(String(type)))
      throw new Error("Invalid layout node");
    if (
      (parent === "tabset" && type !== "tab") ||
      (parent === "row" && type === "tab")
    )
      throw new Error("Invalid layout nesting");
    if (
      typeof value.id !== "string" ||
      !/^[\w#-]{1,100}$/.test(value.id) ||
      ids.has(value.id)
    )
      throw new Error("Invalid or duplicate layout id");
    ids.add(value.id);
    if (
      value.weight !== undefined &&
      (typeof value.weight !== "number" ||
        !Number.isFinite(value.weight) ||
        value.weight <= 0 ||
        value.weight > 100000)
    )
      throw new Error("Invalid layout weight");
    if (type === "tab") {
      if (
        !WORKBENCH_PANELS.includes(
          value.component as (typeof WORKBENCH_PANELS)[number],
        ) ||
        value.id !== value.component ||
        panels.has(value.id)
      )
        throw new Error("Invalid or duplicate panel");
      panels.add(value.id);
      if (typeof value.name !== "string" || value.name.length > 80)
        throw new Error("Invalid panel name");
    } else {
      if (!Array.isArray(value.children))
        throw new Error("Missing layout children");
      for (const child of value.children) visit(child, depth + 1, String(type));
    }
  }
  visit(layout.layout, 0, "root");
  if (
    layout.borders !== undefined &&
    (!Array.isArray(layout.borders) || layout.borders.length)
  )
    throw new Error("Unsupported layout borders");
  if (layout.subLayouts !== undefined) {
    if (
      !record(layout.subLayouts) ||
      Object.keys(layout.subLayouts).length > 10
    )
      throw new Error("Invalid floating layouts");
    for (const sub of Object.values(layout.subLayouts)) {
      if (
        !record(sub) ||
        sub.type !== "float" ||
        !record(sub.rect) ||
        !record(sub.layout) ||
        sub.layout.type !== "row"
      )
        throw new Error("Only internal floating panels are supported");
      for (const key of ["x", "y", "width", "height"])
        if (
          typeof sub.rect[key] !== "number" ||
          !Number.isFinite(sub.rect[key]) ||
          Math.abs(sub.rect[key] as number) > 20000
        )
          throw new Error("Invalid floating bounds");
      if ((sub.rect.width as number) < 1 || (sub.rect.height as number) < 1)
        throw new Error("Invalid floating size");
      visit(sub.layout, 0, "root");
    }
  }
  if (layout.popouts !== undefined)
    throw new Error("Native popouts are not supported");
  if (!panels.has("editor")) throw new Error("Layout must retain the editor");
}
export function getWorkbenchSettings(db: Db, ws: string): WorkbenchSettings {
  const stored = db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    `workbench:${ws}`,
  );
  return stored
    ? (JSON.parse(stored.value) as WorkbenchSettings)
    : {
        version: 1,
        activeProfile: "Build",
        profiles: {},
        keymap: { ...DEFAULT_WORKBENCH_KEYS },
      };
}
export function setWorkbenchSettings(
  db: Db,
  ws: string,
  params: { profile?: unknown; layout?: unknown; keymap?: unknown },
): WorkbenchSettings {
  if (
    !WORKBENCH_PROFILES.includes(
      params.profile as (typeof WORKBENCH_PROFILES)[number],
    )
  )
    throw new Error("Invalid task profile");
  validateLayout(params.layout);
  const previous = getWorkbenchSettings(db, ws);
  const keymap = params.keymap ?? previous.keymap;
  if (!record(keymap) || Object.keys(keymap).length !== 4)
    throw new Error("Invalid keymap");
  const seen = new Set<string>();
  for (const key of Object.keys(DEFAULT_WORKBENCH_KEYS)) {
    const value = keymap[key];
    if (
      typeof value !== "string" ||
      !/^(?:(?:Mod|Ctrl|Meta|Alt|Shift)\+)+(?:[A-Z]|F(?:[1-9]|1[0-2]))$/.test(
        value,
      ) ||
      value.length > 60 ||
      seen.has(value.toLowerCase())
    )
      throw new Error("Invalid or conflicting key binding");
    seen.add(value.toLowerCase());
  }
  const profile = params.profile as WorkbenchSettings["activeProfile"];
  const result: WorkbenchSettings = {
    version: 1,
    activeProfile: profile,
    profiles: { ...previous.profiles, [profile]: params.layout },
    keymap: keymap as WorkbenchSettings["keymap"],
  };
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    `workbench:${ws}`,
    JSON.stringify(result),
  );
  return result;
}
export function searchWorkbench(
  db: Db,
  root: string,
  ws: string,
  query: unknown,
): PaletteEntry[] {
  if (typeof query !== "string" || query.length > 100)
    throw new Error("Invalid palette query");
  const entries: PaletteEntry[] = listWorkspaceFiles(root).files.map(
    (path) => ({
      id: `file:${path}`,
      kind: "file",
      label: path,
      detail: "File",
      path,
    }),
  );
  for (const symbol of db.all<{
    id: number;
    name: string;
    path: string;
    line: number;
  }>("SELECT id, name, path, line FROM idx_symbols WHERE ws = ?", ws)) {
    entries.push({
      id: `symbol:${symbol.id}`,
      kind: "symbol",
      label: symbol.name,
      detail: `${symbol.path}:${symbol.line}`,
      path: symbol.path,
      line: symbol.line,
    });
  }
  // The current runtime records primary/Explore identity on steps and ledger entries, not in agents.
  const agents = db.all<{
    id: string;
    task: string;
    kind: string;
    state: string;
    title: string;
  }>(
    `
    SELECT a.id, a.task, a.kind, a.state, t.title FROM agents a JOIN tasks t ON t.id = a.task WHERE t.ws = ?
    UNION
    SELECT DISTINCT s.agent, s.task, s.agent, 'task ' || t.status, t.title FROM steps s JOIN tasks t ON t.id = s.task WHERE t.ws = ?
    UNION
    SELECT DISTINCT l.agent, l.task, l.agent, 'task ' || t.status, t.title FROM ledger_entries l JOIN tasks t ON t.id = l.task WHERE t.ws = ? AND l.agent IS NOT NULL`,
    ws,
    ws,
    ws,
  );
  for (const agent of agents) {
    entries.push({
      id: `agent:${agent.task}:${agent.id}`,
      kind: "agent",
      label: `${agent.kind} · ${agent.title}`,
      detail: `${agent.id} · ${agent.state}`,
      task: agent.task,
    });
  }
  for (const cp of db.all<{
    id: string;
    task: string;
    title: string;
    at: string;
  }>(
    "SELECT c.id, c.task, c.at, t.title FROM checkpoints c JOIN tasks t ON t.id = c.task WHERE t.ws = ?",
    ws,
  )) {
    entries.push({
      id: cp.id,
      kind: "checkpoint",
      label: `Checkpoint ${cp.id}`,
      detail: `${cp.title} · ${cp.at}`,
      task: cp.task,
      checkpoint: cp.id,
    });
  }
  const ranked = entries
    .map((entry) => ({
      entry,
      score: fuzzyScore(query, `${entry.label} ${entry.detail}`),
    }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return (["file", "symbol", "agent", "checkpoint"] as const).flatMap((kind) =>
    ranked
      .filter(({ entry }) => entry.kind === kind)
      .slice(0, 25)
      .map(({ entry }) => entry),
  );
}
