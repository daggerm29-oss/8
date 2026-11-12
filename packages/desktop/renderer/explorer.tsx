import { t } from "./i18n";
import { useState } from "react";
import { FileCode2, FolderOpen, Search, RefreshCw } from "lucide-react";
import { rpc, useRpc } from "./rpc";
import { confirmDiscard, useWorkbench, type FileDocument } from "./state";
import { useLayout } from "./layout-state";

export async function openFile(path: string, line = 1) {
  const state = useWorkbench.getState();
  if (!confirmDiscard()) return;
  try {
    const document = await rpc.call<FileDocument>("fs.read", {
      workspacePath: state.workspace,
      path,
    });
    if (useWorkbench.getState().workspace === state.workspace) {
      state.openDocument(document, line);
      useLayout.getState().show("editor");
    }
  } catch (error) {
    state.message((error as Error).message);
  }
}
export function Explorer() {
  const workspace = useWorkbench((state) => state.workspace);
  const document = useWorkbench((state) => state.document);
  const [filter, setFilter] = useState("");
  const files = useRpc<{ files: string[]; truncated: boolean }>(
    "fs.tree",
    { workspacePath: workspace },
    !!workspace,
  );
  const shown = (files.data?.files ?? [])
    .filter((file) => file.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 600);
  return (
    <aside className="explorer" aria-label={t("file_explorer_bfd3c6")}>
      <div className="panel-heading">
        <span>{t("explorer_c39d64")}</span>
        <button
          title={t("refresh_files_e2b488")}
          aria-label={t("refresh_files_e2b488")}
          onClick={() => void files.refetch()}
          disabled={!workspace}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="workspace-name">
        <FolderOpen size={15} />
        <span>
          {workspace.split("/").filter(Boolean).at(-1) || t("no_workspace_fce263")}
        </span>
      </div>
      <label className="filter">
        <Search size={13} />
        <input
          aria-label={t("filter_files_56fc0c")}
          placeholder={t("filter_files_56fc0c")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {files.error && <p role="alert">{files.error.message}</p>}
      <nav className="file-list" aria-label={t("workspace_files_bb2e2d")}>
        {shown.map((file) => (
          <button
            key={file}
            className={document?.path === file ? "selected" : ""}
            title={file}
            onClick={() => void openFile(file)}
          >
            <FileCode2 size={14} />
            <span>{file}</span>
          </button>
        ))}
      </nav>
      <p className="list-caption">
        {workspace
          ? t("_0_files_1_01b22b", [files.data?.files.length ?? 0, files.data?.truncated ? t("_truncated_533b27") : ""])
          : t("open_a_workspace_to_begin_590286")}
      </p>
    </aside>
  );
}
