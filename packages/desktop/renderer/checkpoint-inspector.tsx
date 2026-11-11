import { t } from "./i18n";
import { useRpc } from "./rpc";
import { useWorkbench } from "./state";
export function CheckpointInspector() {
  const task = useWorkbench((state) => state.selectedTask);
  const checkpoint = useWorkbench((state) => state.selectedCheckpoint);
  const diff = useRpc<{ path: string; diff?: string; patch?: string }[]>(
    "checkpoint.diff",
    { task, checkpoint },
    !!task && !!checkpoint,
  );
  return checkpoint ? (
    <section className="checkpoint-inspector" aria-label={t("selected_checkpoint_1fbd4f")}>
      <h2>{t("checkpoint_438681")}{checkpoint}</h2>
      <p>{t("changes_since_this_checkpoint_read_only_e8b604")}</p>
      {diff.error && <p role="alert">{diff.error.message}</p>}
      {diff.data?.length ? (
        diff.data.map((file) => (
          <article key={file.path}>
            <strong>{file.path}</strong>
            <pre>{file.diff || file.patch || JSON.stringify(file)}</pre>
          </article>
        ))
      ) : (
        <p>{t("no_file_changes_214229")}</p>
      )}
      <button onClick={() => useWorkbench.setState({ selectedCheckpoint: "" })}>
        {t("dismiss_checkpoint_d2ab8f")}</button>
    </section>
  ) : null;
}
