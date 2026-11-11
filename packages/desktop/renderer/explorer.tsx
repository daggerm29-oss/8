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
    <aside className="explorer" aria-label="File explorer">
      <div className="panel-heading">
        <span>Explorer</span>
        <button
          title="Refresh files"
          aria-label="Refresh files"
          onClick={() => void files.refetch()}
          disabled={!workspace}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="workspace-name">
        <FolderOpen size={15} />
        <span>
          {workspace.split("/").filter(Boolean).at(-1) || "No workspace"}
        </span>
      </div>
      <label className="filter">
        <Search size={13} />
        <input
          aria-label="Filter files"
          placeholder="Filter files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {files.error && <p role="alert">{files.error.message}</p>}
      <nav className="file-list" aria-label="Workspace files">
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
          ? `${files.data?.files.length ?? 0} files${files.data?.truncated ? " · truncated" : ""}`
          : "Open a workspace to begin"}
      </p>
    </aside>
  );
}
