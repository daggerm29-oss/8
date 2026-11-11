import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
};
export function desktopAsset(
  root: string,
  url: string,
): { name: string; type: string } | undefined {
  try {
    const path = decodeURIComponent(url.slice("/desktop/".length));
    if (path.includes("\\") || path.split("/").includes("..")) return;
    const base = realpathSync(root);
    const name = realpathSync(resolve(base, path));
    const type = types[extname(name)];
    if (!name.startsWith(base + sep) || !type || !statSync(name).isFile())
      return;
    return { name, type };
  } catch {
    return;
  }
}
