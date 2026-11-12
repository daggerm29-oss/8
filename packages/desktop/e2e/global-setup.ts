import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export default function setup() {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../setup.cjs", import.meta.url))],
    { stdio: "inherit", timeout: 180_000 },
  );
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../package.mjs", import.meta.url))],
    { stdio: "inherit", timeout: 240_000 },
  );
}
