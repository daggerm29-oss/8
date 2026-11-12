/** Preload bridge (preload.cjs). Absent in the browser-served workbench. */
export interface HelixDesktopBridge {
  readonly shell: "electron";
  readonly platform: string;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  appInfo(): Promise<{ name: string; version: string; platform: string; packaged: boolean; electron: string }>;
  engineConnection(): Promise<{ origin: string; token: string }>;
  engineStatus(): Promise<{ pid: number | null; alive: boolean; origin: string; restarts: number; startedAt: string | null; rendererCrashes: number }>;
  openExternal(url: string): Promise<{ opened: boolean; reason?: string }>;
}

declare global {
  interface Window {
    helixDesktop?: HelixDesktopBridge;
  }
}
