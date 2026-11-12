import { t } from "./i18n";
import { useState } from "react";
import { rpc, queryClient, useRpc } from "./rpc";
import { useWorkbench, type Diagnostic } from "./state";
import { openFile } from "./explorer";

export function PreviewPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string>(t("no_development_server_running_c05797"));
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setMessage(t("starting_sandboxed_development_server_ba8f59"));
    try {
      const result = await rpc.call<{ url: string }>("preview.start", {
        workspacePath: workspace,
      });
      setUrl(result.url);
      setMessage(result.url);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="tool-panel preview-panel"
      aria-label={t("application_preview_05908c")}
    >
      <div className="toolbar">
        <h2>{t("preview_324b13")}</h2>
        <button disabled={!workspace || busy} onClick={() => void start()}>
          {t("start_preview_a27536")}</button>
        {url && (
          <button
            onClick={() => {
              const frame = document.querySelector<HTMLIFrameElement>(
                "#application-preview",
              );
              if (frame) frame.src = url;
            }}
          >
            {t("reload_preview_677c4e")}</button>
        )}
      </div>
      <p className="hint" role="status">
        {message}
      </p>
      {url ? (
        <iframe
          id="application-preview"
          title={t("application_preview_05908c")}
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin"
        />
      ) : (
        <div className="empty-state">
          {t("start_the_workspace_application_in_its_sandbo_80a8c4")}</div>
      )}
    </section>
  );
}
type GitStatus = {
  isRepo: boolean;
  branch: string;
  files: { path: string; index: string; worktree: string }[];
};
export function ScmPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const status = useRpc<GitStatus>(
    "git.status",
    { workspacePath: workspace },
    !!workspace,
  );
  const diff = useRpc<{ staged: string; unstaged: string }>(
    "git.diff",
    { workspacePath: workspace },
    !!workspace && status.data?.isRepo === true,
  );
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (method: string) => {
    setBusy(true);
    try {
      const response = await rpc.call<{ sha?: string }>(method, {
        workspacePath: workspace,
        message,
      });
      setResult(response.sha ? t("committed_0_5d7d69", [response.sha]) : t("changes_staged_5759a5"));
      void queryClient.invalidateQueries({ queryKey: ["git.status"] });
      void queryClient.invalidateQueries({ queryKey: ["git.diff"] });
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label={t("source_control_panel_990ac7")}>
      <div className="toolbar">
        <h2>{t("source_control_9bd7ea")}</h2>
        <span>{status.data?.branch || t("no_repository_446597")}</span>
        <button
          disabled={busy || !status.data?.isRepo}
          onClick={() => void act("git.stageAll")}
        >
          {t("stage_all_6840c6")}</button>
        <button
          onClick={() => {
            void status.refetch();
            void diff.refetch();
          }}
          disabled={!workspace}
        >
          {t("refresh_source_control_9b280e")}</button>
      </div>
      {status.error && <p role="alert">{status.error.message}</p>}
      <ul className="changed-files">
        {status.data?.files.map((file) => (
          <li key={file.path}>
            <code>
              {file.index}
              {file.worktree}
            </code>
            <button onClick={() => void openFile(file.path)}>
              {file.path}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="command-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act("git.commit");
        }}
      >
        <input
          aria-label={t("commit_message_26306d")}
          placeholder={t("describe_the_change_beaee3")}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button disabled={!status.data?.isRepo || !message.trim() || busy}>
          {t("commit_staged_1fa9cc")}</button>
      </form>
      <p role="status">{result}</p>
      <pre className="diff-output" role="region" tabIndex={0} aria-label={t("source_control_diff_eecf19")}>
        {diff.data?.staged}
        {diff.data?.unstaged}
      </pre>
    </section>
  );
}
export function ProblemsPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const problems = useRpc<Diagnostic[]>(
    "problems.list",
    { workspacePath: workspace },
    !!workspace,
  );
  return (
    <section className="tool-panel" aria-label={t("problems_panel_061eeb")}>
      <div className="toolbar">
        <h2>{t("problems_a7b182")}</h2>
        <span>{problems.data?.length ?? 0} {t("_diagnostics_e0336f")}</span>
        <button disabled={!workspace} onClick={() => void problems.refetch()}>
          {t("refresh_problems_cda754")}</button>
      </div>
      {problems.error && <p role="alert">{problems.error.message}</p>}
      {problems.data?.length ? (
        <ul className="problems-list">
          {problems.data.map((problem, index) => (
            <li key={index}>
              <span className="problem-severity">{problem.severity}</span>
              <button
                disabled={!problem.file}
                onClick={() =>
                  problem.file && void openFile(problem.file, problem.line)
                }
              >
                {problem.file || problem.source}{t("_e7ac07")}{problem.line || 1}
              </button>
              <span>
                {problem.code} {problem.message}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          {t("no_reported_problems_run_verification_or_a_co_623cfa")}</div>
      )}
    </section>
  );
}
