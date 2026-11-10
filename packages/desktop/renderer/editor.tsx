import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import { FileCode2, Save, RotateCcw } from "lucide-react";
import { rpc, queryClient } from "./rpc";
import { confirmDiscard, useWorkbench } from "./state";
import { openFile } from "./explorer";

(
  self as typeof self & { MonacoEnvironment: { getWorker(): Worker } }
).MonacoEnvironment = {
  getWorker: () => new Worker("/desktop/editor.worker.js"),
};
const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  css: "css",
  html: "html",
  json: "json",
  md: "markdown",
};
export function Editor() {
  const document = useWorkbench((state) => state.document);
  const workspace = useWorkbench((state) => state.workspace);
  const dirty = useWorkbench((state) => state.dirty);
  const line = useWorkbench((state) => state.openLine);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const state = useWorkbench.getState();
    if (
      !state.document ||
      !state.dirty ||
      state.document.binary ||
      state.document.truncated
    )
      return;
    const { draft, document, workspace } = state;
    setSaving(true);
    try {
      const result = await rpc.call<{ hash: string; size: number }>(
        "fs.write",
        {
          workspacePath: workspace,
          path: document.path,
          content: draft,
          baseHash: document.hash,
        },
      );
      const latest = useWorkbench.getState();
      if (
        latest.workspace === workspace &&
        latest.document?.path === document.path
      )
        latest.saved(draft, result.hash, result.size);
      void queryClient.invalidateQueries({ queryKey: ["git.status"] });
    } catch (error) {
      useWorkbench.getState().message((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (useWorkbench.getState().dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    if (!host.current || !document || document.binary) return;
    const model = monaco.editor.createModel(
      document.content,
      languages[document.path.split(".").at(-1) ?? ""] ?? "plaintext",
      monaco.Uri.parse(
        `helix://workspace/${encodeURIComponent(workspace)}/${document.path}`,
      ),
    );
    const instance = monaco.editor.create(host.current, {
      model,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      minimap: { enabled: false },
      padding: { top: 20 },
      readOnly: document.truncated || document.hash === null,
      scrollBeyondLastLine: false,
      ariaLabel: "Code editor",
      accessibilitySupport: "on",
    });
    editor.current = instance;
    const changes = model.onDidChangeContent(() =>
      useWorkbench.getState().edit(model.getValue()),
    );
    instance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void saveRef.current(),
    );
    host.current.dataset.ready = "true";
    return () => {
      delete host.current?.dataset.ready;
      changes.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [document?.path, workspace]);
  useEffect(() => {
    editor.current?.revealLineInCenter(line);
    editor.current?.setPosition({ lineNumber: line, column: 1 });
  }, [line, document?.path]);
  return (
    <section className="editor-panel" aria-label="Editor">
      <div className="editor-tabs">
        <div className="file-tab">
          <FileCode2 size={14} />
          {document?.path || "Workbench"}
          {dirty && <span aria-label="Unsaved changes" className="dirty-dot" />}
        </div>
        <div className="editor-actions">
          <button
            aria-label="Reload file from disk"
            title="Reload file from disk"
            disabled={!document || saving}
            onClick={() => {
              if (confirmDiscard() && document) {
                useWorkbench.getState().openDocument({ ...document, path: "" });
                void openFile(document.path);
              }
            }}
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving || document?.truncated}
            aria-label="Save file"
          >
            <Save size={14} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {document?.binary ? (
        <div className="empty-state">Binary files cannot be edited.</div>
      ) : document ? (
        <div ref={host} className="monaco-host" data-testid="monaco-host" />
      ) : (
        <div className="editor-welcome">
          <div className="welcome-glyph">H</div>
          <h1>Your workspace, grounded.</h1>
          <p>
            Open a file to start editing.
            <br />
            Every agent action stays observable.
          </p>
          <span>Monaco editor · isolated Engine · sandboxed execution</span>
        </div>
      )}
      {document?.truncated && (
        <p role="status">
          File exceeds the editor size limit; this view is read-only.
        </p>
      )}
    </section>
  );
}
