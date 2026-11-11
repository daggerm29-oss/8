import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  Methods,
  RpcPeer,
  streamTransport,
  fuzzyScore,
  DEFAULT_WORKBENCH_KEYS,
  type WorkbenchSettings,
  type PaletteEntry,
} from "@helix/protocol";
import { Engine } from "../src/engine.ts";
import { Db } from "../src/storage/db.ts";
import {
  validateLayout,
  setWorkbenchSettings,
  getWorkbenchSettings,
} from "../src/workspace/workbench.ts";

const layout = () => ({
  global: { tabEnablePopout: false },
  borders: [],
  layout: {
    type: "row",
    id: "root",
    children: [
      {
        type: "tabset",
        id: "editors",
        children: [
          { type: "tab", id: "editor", component: "editor", name: "Editor" },
        ],
      },
    ],
  },
});
function connect(engine: Engine) {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new RpcPeer(streamTransport(output, input));
  engine.attach(new RpcPeer(streamTransport(input, output)), {
    token: "layout-test-token",
  });
  return client;
}
test("fuzzy search matches omitted letters and boundaries, rejects unrelated text", () => {
  assert.ok(fuzzyScore("opn fil", "Open File") > 0);
  assert.ok(fuzzyScore("grtng", "greeting") > 0);
  assert.equal(fuzzyScore("xyz", "Open File"), -1);
  assert.ok(
    fuzzyScore("open", "Open File") > fuzzyScore("open", "Reopen older entry"),
  );
});
test("layout validation rejects malformed, oversized, duplicate, unknown and native-window layouts", () => {
  assert.doesNotThrow(() => validateLayout(layout()));
  for (const value of [
    null,
    {},
    { layout: { type: "tab", id: "editor" } },
    { ...layout(), popouts: {} },
    {
      ...layout(),
      subLayouts: { evil: { type: "window", layout: layout().layout } },
    },
  ])
    assert.throws(() => validateLayout(value));
  const duplicate = layout();
  duplicate.layout.children.push(duplicate.layout.children[0]);
  assert.throws(() => validateLayout(duplicate), /duplicate/);
  const unknown = layout();
  unknown.layout.children[0].children[0].component = "arbitrary-html";
  assert.throws(() => validateLayout(unknown), /panel/);
  const noEditor = layout();
  noEditor.layout.children = [];
  assert.throws(() => validateLayout(noEditor), /editor/);
  const huge = { ...layout(), config: "x".repeat(131073) };
  assert.throws(() => validateLayout(huge), /size/);
});
test("saved layouts and bindings isolate profiles and workspaces and survive Db reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "helix-layout-db-"));
  const file = join(root, "db.sqlite");
  let db = new Db(file);
  try {
    const build = layout();
    const debug = layout();
    debug.layout.children[0].id = "debug-editors";
    setWorkbenchSettings(db, "one", { profile: "Build", layout: build });
    setWorkbenchSettings(db, "one", {
      profile: "Debug",
      layout: debug,
      keymap: { ...DEFAULT_WORKBENCH_KEYS, files: "Mod+O" },
    });
    assert.deepEqual(getWorkbenchSettings(db, "two").profiles, {});
    assert.throws(
      () =>
        setWorkbenchSettings(db, "one", { profile: "Other", layout: build }),
      /profile/,
    );
    assert.throws(
      () =>
        setWorkbenchSettings(db, "one", {
          profile: "Build",
          layout: build,
          keymap: { ...DEFAULT_WORKBENCH_KEYS, files: "P" },
        }),
      /binding/,
    );
    assert.throws(
      () =>
        setWorkbenchSettings(db, "one", {
          profile: "Build",
          layout: build,
          keymap: {
            ...DEFAULT_WORKBENCH_KEYS,
            files: DEFAULT_WORKBENCH_KEYS.palette,
          },
        }),
      /binding/,
    );
    db.close();
    db = new Db(file);
    const restored = getWorkbenchSettings(db, "one");
    assert.equal(restored.activeProfile, "Debug");
    assert.equal(restored.keymap.files, "Mod+O");
    assert.deepEqual(restored.profiles.Build, build);
    assert.deepEqual(restored.profiles.Debug, debug);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("authenticated RPC confines settings and fuzzy file/symbol/agent/checkpoint results to opened workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "helix-layout-rpc-"));
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  writeFileSync(
    join(repo, "greeting.ts"),
    'export function greeting() { return "hello"; }\n',
  );
  writeFileSync(join(repo, ".env"), "SECRET=never-list");
  writeFileSync(join(other, "outside.ts"), "export const outsider = true;");
  let engine = new Engine({
    home: join(root, "home"),
    env: {},
    mcp: false,
    indexing: false,
    recover: false,
  });
  let client = connect(engine);
  try {
    for (const method of [
      Methods.workbenchSettingsGet,
      Methods.workbenchSettingsSet,
      Methods.workbenchSearch,
    ])
      await assert.rejects(
        client.request(method, { workspacePath: repo }),
        /initialize/,
      );
    await client.request(Methods.initialize, {
      clientName: "layout-test",
      clientVersion: "0.1.0",
      protocolVersion: "0.1.0",
      token: "layout-test-token",
    });
    await assert.rejects(
      client.request(Methods.workbenchSettingsGet, { workspacePath: repo }),
      /unknown workspace/,
    );
    const ws = await client.request<{ id: string }>(Methods.workspaceOpen, {
      workspacePath: repo,
    });
    const ws2 = await client.request<{ id: string }>(Methods.workspaceOpen, {
      workspacePath: other,
    });
    const task = engine.runtime.create({
      workspacePath: repo,
      goal: "Palette agent task",
      start: false,
    });
    const otherTask = engine.runtime.create({
      workspacePath: other,
      goal: "Unrelated task",
      start: false,
    });
    engine.db.run(
      "INSERT INTO agents (id, task, kind, model_role, state) VALUES (?, ?, ?, ?, ?)",
      "agent-palette",
      task.id,
      "explore",
      "coder",
      "done",
    );
    engine.db.run(
      "INSERT INTO agents (id, task, kind, model_role, state) VALUES (?, ?, ?, ?, ?)",
      "outside-agent",
      otherTask.id,
      "explore",
      "coder",
      "done",
    );
    engine.db.run(
      "INSERT INTO checkpoints (id, task, files_json, at) VALUES (?, ?, ?, ?)",
      "ckpt-palette",
      task.id,
      "[]",
      new Date().toISOString(),
    );
    engine.db.run(
      "INSERT INTO checkpoints (id, task, files_json, at) VALUES (?, ?, ?, ?)",
      "ckpt-outside",
      otherTask.id,
      "[]",
      new Date().toISOString(),
    );
    engine.db.run(
      "INSERT INTO steps (id, task, agent, idx, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "step-recorded",
      task.id,
      "primary",
      0,
      "model",
      "done",
      new Date().toISOString(),
    );
    const results = await client.request<PaletteEntry[]>(
      Methods.workbenchSearch,
      { workspacePath: repo, query: "" },
    );
    assert.deepEqual(
      new Set(results.map((entry) => entry.kind)),
      new Set(["file", "symbol", "agent", "checkpoint"]),
    );
    assert.ok(results.some((entry) => entry.id === `agent:${task.id}:primary`));
    assert.ok(!JSON.stringify(results).includes("outside"));
    assert.ok(!JSON.stringify(results).includes(".env"));
    const fuzzy = await client.request<PaletteEntry[]>(
      Methods.workbenchSearch,
      { workspacePath: repo, query: "grtng" },
    );
    assert.ok(
      fuzzy.some(
        (entry) =>
          entry.kind === "symbol" &&
          entry.path === "greeting.ts" &&
          entry.line === 1,
      ),
    );
    await assert.rejects(
      client.request(Methods.workbenchSearch, {
        workspacePath: repo,
        query: "a".repeat(101),
      }),
      /query/,
    );
    const saved = await client.request<WorkbenchSettings>(
      Methods.workbenchSettingsSet,
      { workspacePath: repo, profile: "Review", layout: layout() },
    );
    assert.equal(saved.activeProfile, "Review");
    assert.notEqual(ws.id, ws2.id);
    client.close();
    await engine.close();
    engine = new Engine({
      home: join(root, "home"),
      env: {},
      mcp: false,
      indexing: false,
      recover: false,
    });
    client = connect(engine);
    await client.request(Methods.initialize, {
      clientName: "layout-test",
      clientVersion: "0.1.0",
      protocolVersion: "0.1.0",
      token: "layout-test-token",
    });
    assert.deepEqual(
      await client.request(Methods.workbenchSettingsGet, {
        workspacePath: repo,
      }),
      saved,
    );
    const otherSettings = await client.request<WorkbenchSettings>(
      Methods.workbenchSettingsGet,
      { workspacePath: other },
    );
    assert.deepEqual(otherSettings.profiles, {});
  } finally {
    client.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});
