import { t } from "./i18n";
import { create } from "zustand";
export type Panel =
  | "agent"
  | "terminal"
  | "preview"
  | "problems"
  | "monitor"
  | "scm"
  | "settings"
  | "mcp"
  | "ledger";
export type FileDocument = {
  path: string;
  content: string;
  hash: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
};
export type Diagnostic = {
  source: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  severity: "error" | "warning";
  message: string;
};
export type Task = {
  id: string;
  title: string;
  goal: string;
  workspacePath: string;
  status: string;
  stepCount: number;
  result?: string;
  error?: string;
  checkpointCount?: number;
  ledger?: {
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  };
};
type UiState = {
  workspace: string;
  selectedTask: string;
  selectedCheckpoint: string;
  panel: Panel;
  document: FileDocument | null;
  draft: string;
  dirty: boolean;
  notice: string;
  openLine: number;
  setWorkspace(workspace: string): void;
  setTask(id: string): void;
  setPanel(panel: Panel): void;
  openDocument(document: FileDocument, line?: number): void;
  edit(content: string): void;
  saved(content: string, hash: string, size: number): void;
  message(notice: string): void;
};
export const useWorkbench = create<UiState>((set) => ({
  workspace: "",
  selectedTask: "",
  selectedCheckpoint: "",
  panel: "agent",
  document: null,
  draft: "",
  dirty: false,
  notice: "",
  openLine: 1,
  setWorkspace: (workspace) =>
    set({
      workspace,
      selectedTask: "",
      selectedCheckpoint: "",
      document: null,
      draft: "",
      dirty: false,
      notice: "",
    }),
  setTask: (selectedTask) => set({ selectedTask, selectedCheckpoint: "" }),
  setPanel: (panel) => set({ panel }),
  openDocument: (document, line = 1) =>
    set({
      document,
      draft: document.content,
      dirty: false,
      openLine: line,
      notice: "",
    }),
  edit: (draft) =>
    set((state) => ({ draft, dirty: draft !== state.document?.content })),
  saved: (content, hash, size) =>
    set((state) => ({
      document: state.document
        ? { ...state.document, content, hash, size }
        : null,
      dirty: state.draft !== content,
      notice: t("saved_to_disk_101e5e"),
    })),
  message: (notice) => set({ notice }),
}));
export function confirmDiscard() {
  return (
    !useWorkbench.getState().dirty ||
    window.confirm(t("discard_unsaved_file_changes_1f0a34"))
  );
}
