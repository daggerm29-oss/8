import { t, formatMoney } from "./i18n";
import { useState } from "react";
import { ArrowUp, Bot, Check, X } from "lucide-react";
import { rpc, useRpc, queryClient } from "./rpc";
import { useWorkbench, type Task } from "./state";
import { CheckpointInspector } from "./checkpoint-inspector";
import { ActivityTree } from './activity-tree';
import { TraceViewer } from './trace-viewer';
import { PlanReviewPanel } from './plan-review-panel';
import { GateWaiverPanel } from './gate-waiver-panel';

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
  const planArtifacts = useRpc<{ id: string }[]>(
    "artifact.list",
    { task: selected, kind: "plan" },
    !!selected,
  );
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
    <section className="agent-panel" aria-label={t("agent_panel_1cd35a")}>
      <div className="panel-heading">
        <span>{t("agent_11b39c")}</span>
        <span className="subtle">{t("grounded_single_agent_c24c77")}</span>
      </div>
      <div className="conversation" aria-label={t("agent_conversation_d4bf6d")}>
        {!selected && (
          <div className="agent-empty">
            <Bot size={24} />
            <h2>{t("what_are_we_building_707442")}</h2>
            <p>
              {t("plan_act_and_verify_with_your_code_and_runnin_2d276e")}</p>
            <div className="agent-note">
              <Check size={13} />
              {t("engine_policies_guard_every_action_c4f95c")}</div>
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
        {selected && !!planArtifacts.data?.length && (
          <PlanReviewPanel key={selected} task={selected} />
        )}
        {selected && <GateWaiverPanel key={"waiver-" + selected} task={selected} />}
        {approvals.data
          ?.filter((approval) => approval.status === "pending")
          .map((approval) => (
            <article key={approval.id} className="approval">
              <strong>{t("approve_cb4b25")}{approval.tool}{t("_8a8de8")}</strong>
              <pre>{JSON.stringify(approval.args, null, 2)}</pre>
              <button onClick={() => void approve(approval.id, true)}>
                <Check size={14} />
                {t("approve_cb4b25")}</button>
              <button onClick={() => void approve(approval.id, false)}>
                <X size={14} />
                {t("deny_5982f6")}</button>
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
          {t("task_goal_9cf5b7")}</label>
        <textarea
          id="agent-goal"
          placeholder={t("describe_a_task_for_helix_289b5f")}
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
            aria-label={t("agent_policy_703d88")}
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="interactive">{t("interactive_39a4a7")}</option>
            <option value="plan">{t("plan_mode_3ca7d8")}</option>
            <option value="headless">{t("headless_af9bfb")}</option>
          </select>
          <button
            className="primary"
            aria-label={t("start_task_643f02")}
            disabled={!workspace || !goal.trim() || busy}
          >
            <ArrowUp size={16} />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="hint">
        {t("uses_your_configured_engine_provider_and_role_72379d")}</p>
    </section>
  );
}
export function MonitorPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const selected = useWorkbench((state) => state.selectedTask);
  const monitor = useRpc<Task[]>("task.monitor");
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
    <section className="tool-panel" aria-label={t("task_monitor_panel_a43f66")}>
      <div className="toolbar">
        <h2>{t("task_monitor_ac382a")}</h2>
        <span>{tasks.length} {t("_tasks_21f860")}</span>
        <button onClick={() => void monitor.refetch()}>{t("refresh_tasks_2a1149")}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {tasks.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("task_4bc74b")}</th>
              <th>{t("status_920e41")}</th>
              <th>{t("steps_1de3df")}</th>
              <th>{t("tokens_in_out_56826c")}</th>
              <th>{t("cost_204a5e")}</th>
              <th>{t("checkpoints_d76c24")}</th>
              <th>{t("actions_ff8059")}</th>
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
                  {task.ledger?.inputTokens ?? 0} {t("_3be065")}{" "}
                  {task.ledger?.outputTokens ?? 0}
                </td>
                <td>
                  {task.ledger?.costUsd == null
                    ? t("unknown_b764cd")
                    : formatMoney(task.ledger.costUsd)}
                </td>
                <td>{task.checkpointCount ?? 0}</td>
                <td>
                  <button
                    disabled={["done", "failed", "cancelled"].includes(
                      task.status,
                    )}
                    onClick={() => void cancel(task.id)}
                  >
                    {t("cancel_task_0f0c65")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">{t("no_tasks_in_this_workspace_8627d9")}</div>
      )}
      {selected && <ActivityTree key={`activity:${selected}`} task={selected} />}
      <CheckpointInspector />
      {selected && <TraceViewer key={`trace:${selected}`} task={selected} />}
    </section>
  );
}
