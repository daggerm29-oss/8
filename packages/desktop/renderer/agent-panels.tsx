import { useState } from "react";
import { ArrowUp, Bot, Check, X } from "lucide-react";
import { rpc, useRpc, queryClient } from "./rpc";
import { useWorkbench, type Task } from "./state";
import { CheckpointInspector } from "./checkpoint-inspector";

type Message = {
  role: string;
  parts: { type: string; text?: string; name?: string; content?: string }[];
};
export function AgentPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const selected = useWorkbench((state) => state.selectedTask);
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState("interactive");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const transcript = useRpc<Message[]>(
    "task.transcript",
    { id: selected },
    !!selected,
  );
  const approvals = useRpc<
    { id: string; tool: string; args: unknown; status: string }[]
  >("agent.approvals.list", { task: selected }, !!selected);
  const submit = async () => {
    if (!workspace || !goal.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const task = await rpc.call<Task>("task.create", {
        workspacePath: workspace,
        goal,
        policyProfile: mode,
        start: true,
      });
      useWorkbench.getState().setTask(task.id);
      setGoal("");
      void queryClient.invalidateQueries({ queryKey: ["task.monitor"] });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const approve = async (id: string, approved: boolean) => {
    try {
      await rpc.call("agent.approve", { approvalId: id, approved });
      void approvals.refetch();
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <section className="agent-panel" aria-label="Agent panel">
      <div className="panel-heading">
        <span>Agent</span>
        <span className="subtle">Grounded single agent</span>
      </div>
      <div className="conversation" aria-label="Agent conversation">
        {!selected && (
          <div className="agent-empty">
            <Bot size={24} />
            <h2>What are we building?</h2>
            <p>
              Plan, act, and verify with your code and running environment in
              context.
            </p>
            <div className="agent-note">
              <Check size={13} />
              Engine policies guard every action
            </div>
          </div>
        )}
        {transcript.data
          ?.filter((message) => message.role !== "system")
          .map((message, index) => (
            <article key={index} className="agent-message">
              <strong>{message.role}</strong>
              {message.parts.map((part, index) => (
                <p key={index}>
                  {part.text ||
                    (part.type === "tool_result" ? part.content : part.name)}
                </p>
              ))}
            </article>
          ))}
        {approvals.data
          ?.filter((approval) => approval.status === "pending")
          .map((approval) => (
            <article key={approval.id} className="approval">
              <strong>Approve {approval.tool}?</strong>
              <pre>{JSON.stringify(approval.args, null, 2)}</pre>
              <button onClick={() => void approve(approval.id, true)}>
                <Check size={14} />
                Approve
              </button>
              <button onClick={() => void approve(approval.id, false)}>
                <X size={14} />
                Deny
              </button>
            </article>
          ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="agent-goal">
          Task goal
        </label>
        <textarea
          id="agent-goal"
          placeholder="Describe a task for Helix…"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          <select
            aria-label="Agent policy"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="interactive">Interactive</option>
            <option value="plan">Plan mode</option>
            <option value="headless">Headless</option>
          </select>
          <button
            className="primary"
            aria-label="Start task"
            disabled={!workspace || !goal.trim() || busy}
          >
            <ArrowUp size={16} />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="hint">
        Uses your configured Engine provider and role bindings.
      </p>
    </section>
  );
}
export function MonitorPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const selected = useWorkbench((state) => state.selectedTask);
  const monitor = useRpc<Task[]>("task.monitor");
  const steps = useRpc<
    {
      id: string;
      index: number;
      kind: string;
      status: string;
      text?: string;
      toolCalls: { id: string; tool: string; status: string }[];
    }[]
  >("task.steps", { task: selected }, !!selected);
  const tasks = (monitor.data ?? []).filter(
    (task) => task.workspacePath === workspace,
  );
  const [error, setError] = useState("");
  const cancel = async (id: string) => {
    try {
      await rpc.call("task.cancel", { id });
      void monitor.refetch();
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <section className="tool-panel" aria-label="Task monitor panel">
      <div className="toolbar">
        <h2>Task monitor</h2>
        <span>{tasks.length} tasks</span>
        <button onClick={() => void monitor.refetch()}>Refresh tasks</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {tasks.length ? (
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Tokens in / out</th>
              <th>Cost</th>
              <th>Checkpoints</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <button
                    onClick={() => useWorkbench.getState().setTask(task.id)}
                  >
                    {task.title || task.goal}
                  </button>
                </td>
                <td>{task.status}</td>
                <td>{task.stepCount}</td>
                <td>
                  {task.ledger?.inputTokens ?? 0} /{" "}
                  {task.ledger?.outputTokens ?? 0}
                </td>
                <td>
                  {task.ledger?.costUsd == null
                    ? "Unknown"
                    : `$${task.ledger.costUsd.toFixed(4)}`}
                </td>
                <td>{task.checkpointCount ?? 0}</td>
                <td>
                  <button
                    disabled={["done", "failed", "cancelled"].includes(
                      task.status,
                    )}
                    onClick={() => void cancel(task.id)}
                  >
                    Cancel task
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">No tasks in this workspace.</div>
      )}
      <CheckpointInspector />
      <ol className="step-list">
        {steps.data?.map((step) => (
          <li key={step.id}>
            <strong>
              Step {step.index + 1} · {step.kind} · {step.status}
            </strong>
            <p>{step.text}</p>
            <ul>
              {step.toolCalls.map((call) => (
                <li key={call.id}>
                  {call.tool} · {call.status}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
