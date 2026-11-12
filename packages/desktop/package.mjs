import "./build.mjs";
import { build, Platform } from "electron-builder";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronDir = dirname(require.resolve("electron/package.json"));
await build({
  targets: (process.platform === "darwin"
    ? Platform.MAC
    : process.platform === "win32"
      ? Platform.WINDOWS
      : Platform.LINUX
  ).createTarget("dir"),
  publish: "never",
  config: {
    appId: "dev.helix.desktop",
    productName: "Helix",
    executableName: "helix",
    asar: true,
    electronVersion: require("electron/package.json").version,
    electronDist: join(electronDir, "dist"),
    directories: { app: join(root, "dist/app"), output: join(root, "release") },
    files: ["main.cjs", "preload.cjs", "security.cjs", "package.json"],
    npmRebuild: false,
    extraResources: ["engine", "renderer", "runtime"].map((name) => ({
      from: join(root, "dist", name),
      to: name,
    })),
    linux: { category: "Development" },
    mac: { category: "public.app-category.developer-tools", identity: null },
  },
});
