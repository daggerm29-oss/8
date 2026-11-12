import { t } from "./i18n";
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
    monaco.editor.defineTheme('helix-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '8CB879' }], colors: {} });
    const instance = monaco.editor.create(host.current, {
      model,
      theme: globalThis.document.documentElement.dataset.contrast === 'high' ? 'hc-black' : 'helix-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      minimap: { enabled: false },
      padding: { top: 20 },
      readOnly: document.truncated || document.hash === null,
      scrollBeyondLastLine: false,
      ariaLabel: t("code_editor_571137"),
      accessibilitySupport: "on",
      tabFocusMode: true,
    });
    editor.current = instance;
    const contrast = new MutationObserver(() => monaco.editor.setTheme(globalThis.document.documentElement.dataset.contrast === 'high' ? 'hc-black' : 'helix-dark'));
    contrast.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-contrast'] });
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
      contrast.disconnect();
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
    <section className="editor-panel" aria-label={t("editor_936a16")}>
      <div className="editor-tabs">
        <div className="file-tab">
          <FileCode2 size={14} />
          {document?.path || t("workbench_a4e733")}
          {dirty && <span aria-label={t("unsaved_changes_a710c2")} className="dirty-dot" />}
        </div>
        <div className="editor-actions">
          <button
            aria-label={t("reload_file_from_disk_afd2c9")}
            title={t("reload_file_from_disk_afd2c9")}
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
            aria-label={t("save_file_2a6f7e")}
          >
            <Save size={14} />
            {saving ? t("saving_23e392") : t("save_1509f5")}
          </button>
        </div>
      </div>
      {document?.binary ? (
        <div className="empty-state">{t("binary_files_cannot_be_edited_7045b4")}</div>
      ) : document ? (
        <div ref={host} className="monaco-host" data-testid="monaco-host" />
      ) : (
        <div className="editor-welcome">
          <div className="welcome-glyph">{t("h_44bd7a")}</div>
          <h1>{t("your_workspace_grounded_a71a3e")}</h1>
          <p>
            {t("open_a_file_to_start_editing_a5b2a0")}<br />
            {t("every_agent_action_stays_observable_954049")}</p>
          <span>{t("monaco_editor_isolated_engine_sandboxed_execu_727446")}</span>
        </div>
      )}
      {document?.truncated && (
        <p role="status">
          {t("file_exceeds_the_editor_size_limit_this_view_4d5d51")}</p>
      )}
    </section>
  );
}
