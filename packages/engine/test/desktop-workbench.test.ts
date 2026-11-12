import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { availableBackends } from "../src/sandbox/sandbox.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { Db } from "../src/storage/db.ts";
import { desktopAsset } from "../src/workspace/desktop-assets.ts";
import {
  listProblems,
  recordTerminalProblems,
} from "../src/workspace/problems.ts";
import { RpcPeer, Methods } from "@helix/protocol";
import { streamTransport } from "@helix/protocol";
import { PassThrough } from "node:stream";

test("desktop static asset resolver rejects traversal, secrets, non-assets and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "helix-assets-"));
  try {
    const assets = join(root, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "index.html"), "workbench");
    writeFileSync(join(root, "outside.js"), "outside");
    writeFileSync(join(assets, ".env"), "secret");
    symlinkSync(join(root, "outside.js"), join(assets, "escape.js"));
    assert.equal(
      desktopAsset(assets, "/desktop/index.html")?.type,
      "text/html; charset=utf-8",
    );
    for (const path of [
      "../outside.js",
      "%2e%2e/outside.js",
      "escape.js",
      ".env",
      "absent.js",
      "..\\outside.js",
    ])
      assert.equal(desktopAsset(assets, `/desktop/${path}`), undefined, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop server redirects the root, serves the real renderer and keeps legacy UI opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "helix-desktop-route-"));
  const assets = join(root, "renderer");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>Desktop renderer</title>");
  const engine = new Engine({ home: join(root, "home"), env: {}, mcp: false, indexing: false, recover: false });
  try {
    const { port } = await engine.serve({ ui: true, desktopUiDir: assets });
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/desktop/index.html");
    const renderer = await fetch(`http://127.0.0.1:${port}/desktop/index.html`);
    assert.equal(await renderer.text(), "<title>Desktop renderer</title>");
    assert.match(renderer.headers.get("content-security-policy") ?? "", /script-src 'self';/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 200);
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("relocated packaged Node forwards an actual container HTTP server and tears down", { timeout: 45_000 }, async (t) => {
  if (!availableBackends().includes("local-container")) return t.skip("requires the real local-container backend");
  const root = mkdtempSync(join(tmpdir(), "helix-relocated-node-"));
  const binary = join(root, "node");
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o755);
  const moduleUrl = new URL("../src/preview/devserver.ts", import.meta.url).href;
  try {
    const script = `
      import { DevServers } from ${JSON.stringify(moduleUrl)};
      const servers = new DevServers({});
      try {
        const info = await servers.start(${JSON.stringify(root)}, { timeoutMs: 15000, recipe: {
          command: ${JSON.stringify(`node -e 'require("node:http").createServer((req,res)=>res.end("relocated-container-preview")).listen(3000,"127.0.0.1")'`)},
          port: 3000, framework: 'node', packageManager: 'npm', script: 'dev'
        }});
        console.log(await (await fetch(info.url)).text());
      } finally { await servers.closeAll(); }
    `;
    const { stdout } = await promisify(execFile)(binary, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, HELIX_SANDBOX_PROVIDER: "local-container" }, timeout: 35_000,
    });
    assert.match(stdout, /relocated-container-preview/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Problems isolates workspaces, redacts, persists, and clears terminal diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "helix-problems-"));
  const file = join(root, "state.sqlite");
  let db = new Db(file);
  try {
    recordTerminalProblems(
      db,
      "a",
      "tsc",
      "src/a.ts(2,3): error TS2322: invalid value",
    );
    assert.equal(listProblems(db, "a")[0].line, 2);
    assert.deepEqual(listProblems(db, "b"), []);
    db.close();
    db = new Db(file);
    assert.equal(listProblems(db, "a")[0].code, "TS2322");
    recordTerminalProblems(db, "a", "tsc", "");
    assert.deepEqual(listProblems(db, "a"), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.open registers a real directory without creating a task or requiring a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "helix-workspace-open-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "hello.ts"), "export const hello = 1;");
  const engine = new Engine({
    home: join(root, "home"),
    env: {},
    mcp: false,
    indexing: false,
    recover: false,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new RpcPeer(streamTransport(output, input));
  engine.serveStdio(input, output);
  try {
    await client.request(Methods.initialize, {
      clientName: "desktop-test",
      clientVersion: "0.1.0",
      protocolVersion: "0.1.0",
    });
    const workspace = await client.request<{ path: string }>(
      Methods.workspaceOpen,
      { workspacePath: repo },
    );
    assert.equal(workspace.path, repo);
    assert.deepEqual(await client.request(Methods.taskList, {}), []);
    assert.deepEqual(
      (
        await client.request<{ files: string[] }>(Methods.fsTree, {
          workspacePath: repo,
        })
      ).files,
      ["hello.ts"],
    );
    assert.deepEqual(
      await client.request(Methods.problemsList, { workspacePath: repo }),
      [],
    );
    await assert.rejects(
      client.request(Methods.workspaceOpen, {
        workspacePath: join(repo, "hello.ts"),
      }),
      /directory/,
    );
    await assert.rejects(client.request(Methods.workspaceOpen, {}), /required/);
    await assert.rejects(
      client.request(Methods.problemsList, { workspacePath: root }),
      /unknown workspace/,
    );
  } finally {
    client.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});
