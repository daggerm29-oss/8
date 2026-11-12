import { t, formatMoney } from "./i18n";
import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ActivityAgent, ActivityUsage, TaskActivity, TaskSummary } from '@helix/protocol';
import { rpc, queryClient } from './rpc';
import { useWorkbench } from './state';
import './activity-tree.css';

const money = (value: number | null) => value === null ? t("unknown_cost_03a016") : formatMoney(value);
const elapsed = (start: string, end: string | null) => t("_0_s_dae58f", [Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000).toFixed(1)]);
function Usage({ usage }: { usage: ActivityUsage }) {
  return <span className="activity-usage">{usage.inputTokens} {t("_in_ccbc4b")}{usage.outputTokens} {t("_out_b43652")}{money(usage.costUsd)}</span>;
}
function AgentBranch({ agent, activity }: { agent: ActivityAgent; activity: TaskActivity }) {
  const status = ['paused', 'pausing'].includes(activity.status) && agent.status === 'running' ? activity.status : agent.status;
  return <li data-agent={agent.id}>
    <details open className="activity-agent">
      <summary><strong>{agent.kind === 'primary' ? t("primary_agent_5bb0b5") : t("explore_subagent_cd4148")}</strong><span className="activity-status">{status}</span><span>{elapsed(agent.startedAt, agent.endedAt)}</span><Usage usage={agent.usage} /></summary>
      <p className="hint">{agent.role} {t("_588da4")}{agent.id}{agent.parentCall ? t("_launched_by_0_cfd8f3", [agent.parentCall]) : ''}</p>
      <ol aria-label={t("_0_steps_5cd7f9", [agent.kind])}>
        {agent.steps.map((step) => <li key={step.id} data-step={step.id}>
          <details className="activity-step" open>
            <summary><strong>{t("step_474a98")}{step.index + 1} {t("_588da4")}{step.kind}</strong><span className="activity-status">{step.status}</span><span>{elapsed(step.startedAt, step.endedAt)}</span><Usage usage={step.usage} /></summary>
            {step.model && <span className="hint">{step.model}</span>}
            {step.text && <p className="activity-output">{step.text}</p>}
            <details className="activity-context"><summary>{t("prompt_composition_estimated_tokens_86bb74")}</summary>
              {Object.keys(step.context).length ? <>
                <dl>{Object.entries(step.context).map(([kind, tokens]) => <div key={kind}><dt>{kind}</dt><dd>{tokens}</dd></div>)}</dl>
                {!!step.contextItems?.length && <ul className="activity-context-items" aria-label={t("prompt_context_items_f677a8")}>{step.contextItems.map((item, idx) => <li key={`${item.kind}:${item.label}:${idx}`}><span>{item.kind}{t("_45822f")}{item.label}</span><span>{item.tokens} {t("_tok_229887")}</span></li>)}</ul>}
              </> : <p className="hint">{t("no_recorded_model_context_for_this_step_16881a")}</p>}
            </details>
            <ol aria-label={t("tool_calls_da5122")}>
              {step.tools.map((tool) => <li key={tool.id} data-tool-call={tool.id}>
                <div className="activity-tool"><strong>{tool.tool}</strong><span className="activity-status">{tool.status}</span><span>{tool.durationMs === null ? t("pending_duration_a8dc09") : t("_0_ms_978a60", [tool.durationMs])}</span></div>
                {tool.summary && <p className="hint">{tool.summary}</p>}
                {tool.checkpoint && <button className="activity-checkpoint" onClick={() => useWorkbench.setState({ selectedCheckpoint: tool.checkpoint })}>{t("inspect_checkpoint_08ad60")}{tool.checkpoint}</button>}
                {activity.agents.some((child) => child.parentCall === tool.id) && <ol aria-label={t("subagents_88296a")}>{activity.agents.filter((child) => child.parentCall === tool.id).map((child) => <AgentBranch key={child.id} agent={child} activity={activity} />)}</ol>}
              </li>)}
            </ol>
          </details>
        </li>)}
      </ol>
    </details>
  </li>;
}
export function ActivityTree({ task }: { task: string }) {
  const key = ['task.activity', { task }];
  const { data, error } = useQuery<TaskActivity>({
    queryKey: key,
    queryFn: async () => {
      const snapshot = await rpc.call<TaskActivity>('task.activity', { task });
      const cached = queryClient.getQueryData<TaskActivity>(key);
      return cached && cached.emittedAt > snapshot.emittedAt ? cached : snapshot;
    },
  });
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [checkpoint, setCheckpoint] = useState('');
  const [modelRef, setModelRef] = useState('');
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (data && root.current) root.current.dataset.committedAt = String(Date.now());
  }, [data]);
  const control = async (method: string, params: object = { id: task }) => {
    setBusy(method); setFailure(''); setNotice('');
    try {
      const result = await rpc.call(method, params);
      if (method === 'task.fork') {
        const forked = result as TaskSummary;
        await queryClient.invalidateQueries({ queryKey: ['task.monitor'] });
        useWorkbench.getState().setTask(forked.id);
        return;
      }
      const snapshot = await rpc.call<TaskActivity>('task.activity', { task });
      queryClient.setQueryData(key, snapshot);
      void queryClient.invalidateQueries({ queryKey: ['task.monitor'] });
      if (method === 'task.rollback') {
        setNotice(t("checkpoint_restored_reopen_changed_files_to_r_12fed3"));
        void queryClient.invalidateQueries({ queryKey: ['checkpoint.diff'] });
      } else if (method === 'task.setModel') {
        setNotice(t("model_updated_to_0_1_7fbf52", [snapshot.provider, snapshot.model]));
      }
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(''); }
  };
  if (!data) return <p role={error ? 'alert' : 'status'}>{error?.message ?? t("loading_activity_a389c3")}</p>;
  const terminal = ['done', 'failed', 'cancelled'].includes(data.status);
  const paused = ['paused', 'pausing'].includes(data.status);
  const target = checkpoint || data.checkpoints.at(-1)?.id || '';
  const currentModel = `${data.provider}/${data.model}`;
  const selectedModel = modelRef || currentModel;
  const pending = data.approvals.filter((a) => a.status === 'pending');
  const heldLeases = data.leases.filter((l) => l.state === 'held').length;
  const approve = async (approved: boolean) => {
    setBusy('approvals'); setFailure('');
    try { for (const a of pending) await rpc.call('agent.approve', { approvalId: a.id, approved }); }
    catch (error) { setFailure((error as Error).message); }
    finally { setBusy(''); }
  };
  const changeModel = () => {
    const slash = selectedModel.indexOf('/');
    if (slash <= 0) return;
    void control('task.setModel', { id: task, provider: selectedModel.slice(0, slash), model: selectedModel.slice(slash + 1) });
  };
  return <section ref={root} className="activity-tree" aria-label={t("live_agent_activity_234b89")} data-event-at={data.emittedAt} data-task={task}>
    <div className="activity-heading"><h2>{t("agent_activity_2ac2e7")}</h2><span className="activity-status" role="status">{data.status}</span><span>{elapsed(data.startedAt, data.endedAt)}</span><Usage usage={data.usage} /></div>
    <div className="activity-controls">
      <button disabled={!!busy || terminal || paused} onClick={() => void control('task.pause')}>{busy === 'task.pause' ? t("pausing_safely_17bccc") : t("pause_858e4b")}</button>
      <button disabled={!!busy || terminal || data.status !== 'paused'} onClick={() => void control('task.resume')}>{t("resume_d640c7")}</button>
      <button disabled={!!busy || terminal} onClick={() => void control('task.cancel')}>{t("cancel_19766e")}</button>
      <label>{t("rollback_checkpoint_111f20")}<select aria-label={t("rollback_checkpoint_111f20")} value={target} onChange={(event) => setCheckpoint(event.target.value)}>{data.checkpoints.map((c, i) => <option key={c.id} value={c.id}>{i + 1} {t("_588da4")}{c.files.join(', ') || t("read_only_marker_4f33e6")} {t("_588da4")}{c.id}</option>)}</select></label>
      <button disabled={!!busy || !target} onClick={() => {
        if (window.confirm(t("pause_this_task_and_restore_file_contents_to_46739e"))) void control('task.rollback', { task, checkpoint: target });
      }}>{t("roll_back_931f70")}</button>
      <button disabled={!!busy || !target} onClick={() => void control('task.fork', { task, checkpoint: target })}>{t("fork_checkpoint_7ea4c3")}</button>
      <label>{t("task_model_abc6a5")}<select aria-label={t("task_model_abc6a5")} value={selectedModel} onChange={(event) => setModelRef(event.target.value)}>{data.availableModels.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
      <button disabled={!!busy || terminal || selectedModel === currentModel} onClick={changeModel}>{t("change_model_d9a955")}</button>
    </div>
    {(failure || error) && <p role="alert">{failure || error?.message}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="activity-resources">
      <div><h3>{t("task_budget_50f658")}</h3>{data.budget ? <p>{t("soft_731c8b")}{data.budget.softUsd === null ? t("not_set_1aef93") : money(data.budget.softUsd)} {t("_hard_d53240")}{data.budget.hardUsd === null ? t("not_set_1aef93") : money(data.budget.hardUsd)}<br />{t("tokens_soft_174324")}{data.budget.softTokens ?? t("not_set_1aef93")} {t("_hard_370eb4")}{data.budget.hardTokens ?? t("not_set_1aef93")}</p> : <p className="hint">{t("no_task_limit_configured_37d7ca")}</p>}<Usage usage={data.usage} /></div>
      <div><h3>{t("write_leases_b3e045")}</h3>{data.leases.length ? <ul aria-label={t("write_leases_b3e045")}>{data.leases.map((lease) => <li key={lease.id} data-lease-state={lease.state}><strong>{lease.holder} {t("_588da4")}{lease.mode} {t("_588da4")}{lease.state}</strong><span>{lease.globs.join(', ')} {t("_heartbeat_e2c2a3")}{lease.heartbeat} {t("_expires_886eec")}{lease.expiresAt}</span></li>)}</ul> : <p className="hint">{t("no_held_write_leases_read_only_tools_do_not_a_d30b4a")}</p>}</div>
      <div><h3>{t("last_checkpoint_d6ea2e")}</h3><p>{data.checkpoints.at(-1)?.id ?? t("none_yet_adb85c")}</p><span className="hint">{data.checkpoints.length} {t("_durable_tool_boundaries_62ea57")}</span></div>
    </div>
    {!!pending.length && <div className="approval"><strong>{pending.length} {t("_pending_approval_s_972bb5")}</strong><p>{pending.map((a) => a.tool).join(', ')}</p><button disabled={!!busy} onClick={() => void approve(true)}>{t("approve_all_ae067b")}</button><button disabled={!!busy} onClick={() => void approve(false)}>{t("deny_all_5a4180")}</button></div>}
    <ol className="activity-branches" aria-label={t("task_agent_activity_tree_37d078")}>
      <li data-task-node={data.task}>
        <details open className="activity-task">
          <summary><strong>{t("task_4a1efd")}{data.title}</strong><span className="activity-status">{data.status}</span><span>{elapsed(data.startedAt, data.endedAt)}</span><Usage usage={data.usage} /></summary>
          <p className="hint">{currentModel} {t("_588da4")}{heldLeases} {t("_held_lease_s_last_checkpoint_c7b60e")}{data.checkpoints.at(-1)?.id ?? 'none'}{data.forkedFrom ? t("_forked_from_0_1_0e8b5e", [data.forkedFrom.task, data.forkedFrom.checkpoint]) : ''}</p>
          <ol aria-label={t("agents_279b44")}>{data.agents.filter((a) => !a.parent).map((agent) => <AgentBranch key={agent.id} agent={agent} activity={data} />)}</ol>
        </details>
      </li>
    </ol>
  </section>;
}
