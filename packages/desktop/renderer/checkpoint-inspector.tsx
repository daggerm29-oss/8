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
    <section className="checkpoint-inspector" aria-label="Selected checkpoint">
      <h2>Checkpoint {checkpoint}</h2>
      <p>Changes since this checkpoint (read-only)</p>
      {diff.error && <p role="alert">{diff.error.message}</p>}
      {diff.data?.length ? (
        diff.data.map((file) => (
          <article key={file.path}>
            <strong>{file.path}</strong>
            <pre>{file.diff || file.patch || JSON.stringify(file)}</pre>
          </article>
        ))
      ) : (
        <p>No file changes.</p>
      )}
      <button onClick={() => useWorkbench.setState({ selectedCheckpoint: "" })}>
        Dismiss checkpoint
      </button>
    </section>
  ) : null;
}
