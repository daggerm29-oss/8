export const WORKBENCH_PROFILES = [
  "Build",
  "Debug",
  "Review",
  "Explore",
] as const;
export type WorkbenchProfile = (typeof WORKBENCH_PROFILES)[number];
export const WORKBENCH_PANELS = [
  "explorer",
  "editor",
  "agent",
  "terminal",
  "preview",
  "problems",
  "monitor",
  "scm",
  "settings",
  "mcp",
] as const;
export type WorkbenchPanel = (typeof WORKBENCH_PANELS)[number];
export const DEFAULT_WORKBENCH_KEYS = {
  palette: "Mod+Shift+P",
  files: "Mod+P",
  nextGroup: "Ctrl+F6",
  previousGroup: "Ctrl+Shift+F6",
};
export type WorkbenchKeys = typeof DEFAULT_WORKBENCH_KEYS;
export type WorkbenchSettings = {
  version: 1;
  activeProfile: WorkbenchProfile;
  profiles: Partial<Record<WorkbenchProfile, object>>;
  keymap: WorkbenchKeys;
};
export type PaletteEntry = {
  id: string;
  kind: "file" | "symbol" | "agent" | "checkpoint";
  label: string;
  detail: string;
  path?: string;
  line?: number;
  task?: string;
  checkpoint?: string;
};

export function fuzzyScore(query: string, text: string): number {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const haystack = text.toLowerCase();
  if (!needle) return 0;
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return -1;
    score +=
      10 +
      (index === previous + 1 ? 8 : 0) +
      (index === 0 || /[\s/_\-.]/.test(haystack[index - 1]) ? 12 : 0);
    score -= index - cursor;
    previous = index;
    cursor = index + 1;
  }
  return Math.max(1, score + Math.max(0, 30 - haystack.length));
}
