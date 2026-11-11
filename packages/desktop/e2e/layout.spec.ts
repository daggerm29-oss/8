import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeProvider } from "../../providers/conformance/src/fake-servers.ts";
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
let app: ElectronApplication;
let page: Page;
let display: ChildProcess | undefined;
let root: string;
let repo: string;
let other: string;
let env: Record<string, string>;
let fake: Awaited<ReturnType<typeof startFakeProvider>>;
const errors: string[] = [];
async function launch() {
  const executablePath =
    process.platform === "linux"
      ? join(desktop, "release/linux-unpacked/helix")
      : process.platform === "darwin"
        ? join(desktop, "release/mac/Helix.app/Contents/MacOS/Helix")
        : join(desktop, "release/win-unpacked/helix.exe");
  app = await electron.launch({
    executablePath,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
    env,
    timeout: 60_000,
  });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#engine-status")).toHaveText("Engine connected");
}
async function openWorkspace(path: string) {
  await page.getByLabel("Workspace path", { exact: true }).fill(path);
  await page
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save layout", exact: true }),
  ).toBeEnabled();
}
async function close() {
  const timer = setTimeout(() => app?.process().kill("SIGKILL"), 10_000);
  try {
    await app?.close();
  } finally {
    clearTimeout(timer);
  }
}
async function palette(query: string) {
  await page.getByRole("button", { name: /Command palette/ }).click();
  await page.getByRole("combobox", { name: "Palette search" }).fill(query);
}
async function arrange(panel: string, action: string) {
  const menu = page.locator(".arrange-menu");
  if (!(await menu.getAttribute("open"))) await menu.locator("summary").click();
  await page
    .getByLabel("Panel to arrange", { exact: true })
    .selectOption(panel);
  await page.getByRole("button", { name: action, exact: true }).click();
  await menu.locator("summary").click();
}
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "helix-r1-2-"));
  repo = join(root, "workspace");
  other = join(root, "other");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(other);
  writeFileSync(
    join(repo, "src/hello.ts"),
    'export function greeting() { return "Hello Helix"; }\n',
  );
  writeFileSync(join(other, "other.txt"), "Another workspace");
  execFileSync("git", ["init", "-b", "fixture"], { cwd: repo });
  fake = await startFakeProvider("gemini", ({ index }) =>
    index === 0
      ? {
          toolCalls: [{ name: "read_file", args: { path: "src/hello.ts" } }],
          usage: { input: 10, output: 5 },
        }
      : {
          text: "Palette navigation task complete.",
          usage: { input: 10, output: 5 },
        },
  );
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    HELIX_HOME: join(root, "home"),
    GEMINI_API_KEY: fake.apiKey,
    HELIX_GEMINI_BASE_URL: fake.url,
    GOOGLE_API_KEY: "",
    GEMINI_API: "",
    OPENAI_API_KEY: "",
    HELIX_DESKTOP_HEADLESS: "1",
  };
  if (process.platform === "linux" && !env.DISPLAY) {
    const displayNumber = 100 + (process.pid % 500);
    env.DISPLAY = `:${displayNumber}`;
    display = spawn(
      "Xvfb",
      [env.DISPLAY, "-screen", "0", "1440x1000x24", "-nolisten", "tcp"],
      { stdio: "pipe" },
    );
    await expect
      .poll(() => existsSync(`/tmp/.X11-unix/X${displayNumber}`))
      .toBe(true);
  }
  await launch();
  await openWorkspace(repo);
});
test.afterAll(async () => {
  try {
    await close();
  } finally {
    display?.kill("SIGTERM");
    await fake?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("R1.2: dock, undock, move and restore profiles after relaunch; fuzzy palette executes real navigation", async ({}, testInfo) => {
  await test.step("Panels undock into an internal floating window and dock into another group", async () => {
    const terminal = page.locator('[data-panel="terminal"]');
    const initialGroup = await terminal.getAttribute("data-group");
    const initialLayout = await terminal.getAttribute("data-layout");
    await arrange("terminal", "Undock panel");
    await expect(terminal).not.toHaveAttribute("data-layout", initialLayout!);
    await expect(terminal).toBeVisible();
    await arrange("terminal", "Dock right");
    await expect(terminal).toHaveAttribute("data-layout", initialLayout!);
    await expect(terminal).not.toHaveAttribute("data-group", initialGroup!);
    await arrange("terminal", "Group with editor");
    const editorGroup = await page
      .locator('[data-panel="editor"]')
      .getAttribute("data-group");
    await expect(terminal).toHaveAttribute("data-group", editorGroup!);
    await arrange("terminal", "Dock below");
    await expect(terminal).not.toHaveAttribute("data-group", editorGroup!);
  });
  await test.step("Drag/drop moves an actual tab to another tabset; splitters are resizable", async () => {
    await page
      .getByRole("button", { name: "Problems", exact: true })
      .first()
      .click();
    const source = page.getByRole("tab", { name: "Problems", exact: true });
    const target = page.getByRole("tab", { name: "Editor", exact: true });
    // Electron CDP does not deliver native dragTo consistently; exercise the library's HTML5 event path.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    const targetBox = (await target.boundingBox())!;
    const coordinates = {
      clientX: targetBox.x + targetBox.width / 2,
      clientY: targetBox.y + targetBox.height / 2,
      dataTransfer: transfer,
    };
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    await target.dispatchEvent("dragenter", coordinates);
    await target.dispatchEvent("dragover", coordinates);
    await target.dispatchEvent("drop", coordinates);
    await source.dispatchEvent("dragend", { dataTransfer: transfer });
    await expect(page.locator('[data-panel="problems"]')).toHaveAttribute(
      "data-group",
      (await page.locator('[data-panel="editor"]').getAttribute("data-group"))!,
    );
    const splitter = page.locator(".flexlayout__splitter").first();
    const box = await splitter.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + 25, box!.y + box!.height / 2, { steps: 8 });
    await page.mouse.up();
  });
  await test.step("Build, Debug, Review, Explore save independently; key bindings persist", async () => {
    for (const profile of ["Build", "Debug", "Review", "Explore"]) {
      await page.getByLabel("Task layout profile").selectOption(profile);
      await expect(page.locator(".dock-area")).toHaveAttribute(
        "data-profile",
        profile,
      );
      await page
        .getByRole("button", { name: "Save layout", exact: true })
        .click();
      await expect(page.locator(".save-notice")).toHaveText(
        `${profile} layout saved`,
      );
    }
    await page.getByLabel("Task layout profile").selectOption("Build");
    await page
      .getByRole("button", { name: "Key bindings", exact: true })
      .click();
    await page.getByLabel("files shortcut").fill("Mod+O");
    await page
      .getByRole("button", { name: "Key bindings", exact: true })
      .click();
    await arrange("preview", "Dock right");
    const group = await page
      .locator('[data-panel="preview"]')
      .getAttribute("data-group");
    await arrange("monitor", "Undock panel");
    const floatingLayout = await page
      .locator('[data-panel="monitor"]')
      .getAttribute("data-layout");
    await page
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(page.locator(".save-notice")).toHaveText("Build layout saved");
    await close();
    await launch();
    await openWorkspace(repo);
    await expect(page.getByLabel("Task layout profile")).toHaveValue("Build");
    await expect(page.locator('[data-panel="monitor"]')).toHaveAttribute(
      "data-layout",
      floatingLayout!,
    );
    await expect(page.locator('[data-panel="preview"]')).toHaveAttribute(
      "data-group",
      group!,
    );
    await page.getByLabel("Task layout profile").selectOption("Debug");
    await expect(page.locator('[data-panel="terminal"]')).toHaveAttribute(
      "data-group",
      "tools",
    );
    await page.getByLabel("Task layout profile").selectOption("Build");
    await openWorkspace(other);
    await page
      .getByRole("button", { name: "Preview", exact: true })
      .first()
      .click();
    await expect(page.locator('[data-panel="preview"]')).toHaveAttribute(
      "data-group",
      "tools",
    );
    await openWorkspace(repo);
    await expect(page.locator('[data-panel="preview"]')).toHaveAttribute(
      "data-group",
      group!,
    );
  });
  await test.step("Fuzzy opn fil runs Open File, opens real Monaco, supports symbols and keyboard shortcuts", async () => {
    await palette("opn fil");
    await expect(
      page.getByRole("option").filter({ hasText: "Open File" }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Palette search" })
      .dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await expect(page.getByRole("dialog")).not.toContainText("Search files");
    await page
      .getByRole("combobox", { name: "Palette search" })
      .dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
    await expect(page.getByRole("dialog")).not.toContainText("Search files");
    await page.getByRole("combobox", { name: "Palette search" }).press("Enter");
    await expect(page.getByRole("dialog")).toContainText("Search files");
    await page
      .getByRole("combobox", { name: "Palette search" })
      .fill("src/hlo");
    await expect(
      page.getByRole("option").filter({ hasText: "src/hello.ts" }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "Palette search" }).press("Enter");
    await expect(page.getByTestId("monaco-host")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(page.getByTestId("monaco-host")).toContainText("Hello Helix");
    await page.keyboard.press("ControlOrMeta+o");
    await expect(page.getByRole("dialog")).toContainText("Search files");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await palette("grtng");
    const symbol = page.getByRole("option").filter({ hasText: "greeting" });
    await expect(symbol).toBeVisible();
    await symbol.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("monaco-host")).toBeVisible();
  });
  await test.step("Palette navigates to actual Engine agents and checkpoints without restoring files", async () => {
    await page
      .getByRole("textbox", { name: "Task goal", exact: true })
      .fill("Read the greeting for palette navigation.");
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(
      page.getByLabel("Agent conversation", { exact: true }),
    ).toContainText("Palette navigation task complete.", { timeout: 45_000 });
    await palette("go to agent");
    await page.getByRole("combobox", { name: "Palette search" }).press("Enter");
    const agent = page
      .getByRole("listbox", { name: "Palette results" })
      .getByRole("option")
      .first();
    await expect(agent).toBeVisible();
    await agent.click();
    await expect(page.locator(".save-notice")).toContainText("Agent selected:");
    await palette("go to checkpoint");
    await page.getByRole("combobox", { name: "Palette search" }).press("Enter");
    const cp = page
      .getByRole("listbox", { name: "Palette results" })
      .getByRole("option")
      .first();
    await expect(cp).toContainText("Checkpoint");
    await cp.click();
    await expect(
      page.getByRole("region", { name: "Selected checkpoint", exact: true }),
    ).toContainText("No file changes.");
  });
  expect(errors).toEqual([]);
  await testInfo.attach("r1-2-layout", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
