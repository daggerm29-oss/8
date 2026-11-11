import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ActivityAgent, ActivityUsage, TaskActivity } from '@helix/protocol';
import { rpc, queryClient } from './rpc';
import { useWorkbench } from './state';
import './activity-tree.css';

const money = (value: number | null) => value === null ? 'Unknown cost' : `$${value.toFixed(4)}`;
const elapsed = (start: string, end: string | null) => `${Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000).toFixed(1)} s`;
function Usage({ usage }: { usage: ActivityUsage }) {
  return <span className="activity-usage">{usage.inputTokens} in / {usage.outputTokens} out · {money(usage.costUsd)}</span>;
}
function AgentBranch({ agent, activity }: { agent: ActivityAgent; activity: TaskActivity }) {
  const status = ['paused', 'pausing'].includes(activity.status) && agent.status === 'running' ? activity.status : agent.status;
  return <li data-agent={agent.id}>
    <details open className="activity-agent">
      <summary><strong>{agent.kind === 'primary' ? 'Primary agent' : 'Explore subagent'}</strong><span className="activity-status">{status}</span><span>{elapsed(agent.startedAt, agent.endedAt)}</span><Usage usage={agent.usage} /></summary>
      <p className="hint">{agent.role} · {agent.id}{agent.parentCall ? ` · launched by ${agent.parentCall}` : ''}</p>
      <ol aria-label={`${agent.kind} steps`}>
        {agent.steps.map((step) => <li key={step.id} data-step={step.id}>
          <details className="activity-step" open>
            <summary><strong>Step {step.index + 1} · {step.kind}</strong><span className="activity-status">{step.status}</span><span>{elapsed(step.startedAt, step.endedAt)}</span><Usage usage={step.usage} /></summary>
            {step.model && <span className="hint">{step.model}</span>}
            {step.text && <p className="activity-output">{step.text}</p>}
            <details className="activity-context"><summary>Prompt composition (estimated tokens)</summary>
              {Object.keys(step.context).length ? <dl>{Object.entries(step.context).map(([kind, tokens]) => <div key={kind}><dt>{kind}</dt><dd>{tokens}</dd></div>)}</dl> : <p className="hint">No recorded model context for this step.</p>}
            </details>
            <ol aria-label="Tool calls">
              {step.tools.map((tool) => <li key={tool.id} data-tool-call={tool.id}>
                <div className="activity-tool"><strong>{tool.tool}</strong><span className="activity-status">{tool.status}</span><span>{tool.durationMs === null ? 'Pending duration' : `${tool.durationMs} ms`}</span></div>
                {tool.summary && <p className="hint">{tool.summary}</p>}
                {tool.checkpoint && <button className="activity-checkpoint" onClick={() => useWorkbench.setState({ selectedCheckpoint: tool.checkpoint })}>Inspect checkpoint {tool.checkpoint}</button>}
                {activity.agents.some((child) => child.parentCall === tool.id) && <ol aria-label="Subagents">{activity.agents.filter((child) => child.parentCall === tool.id).map((child) => <AgentBranch key={child.id} agent={child} activity={activity} />)}</ol>}
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
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (data && root.current) root.current.dataset.committedAt = String(Date.now());
  }, [data]);
  const control = async (method: string, params: object = { id: task }) => {
    setBusy(method); setFailure(''); setNotice('');
    try {
      await rpc.call(method, params);
      const snapshot = await rpc.call<TaskActivity>('task.activity', { task });
      queryClient.setQueryData(key, snapshot);
      void queryClient.invalidateQueries({ queryKey: ['task.monitor'] });
      if (method === 'task.rollback') {
        setNotice('Checkpoint restored. Reopen changed files to refresh the editor.');
        void queryClient.invalidateQueries({ queryKey: ['checkpoint.diff'] });
      }
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(''); }
  };
  if (!data) return <p role={error ? 'alert' : 'status'}>{error?.message ?? 'Loading activity…'}</p>;
  const terminal = ['done', 'failed', 'cancelled'].includes(data.status);
  const paused = ['paused', 'pausing'].includes(data.status);
  const target = checkpoint || data.checkpoints.at(-1)?.id || '';
  const pending = data.approvals.filter((a) => a.status === 'pending');
  const approve = async (approved: boolean) => {
    setBusy('approvals'); setFailure('');
    try { for (const a of pending) await rpc.call('agent.approve', { approvalId: a.id, approved }); }
    catch (error) { setFailure((error as Error).message); }
    finally { setBusy(''); }
  };
  return <section ref={root} className="activity-tree" aria-label="Live agent activity" data-event-at={data.emittedAt} data-task={task}>
    <div className="activity-heading"><h2>Agent activity</h2><span className="activity-status" role="status">{data.status}</span><Usage usage={data.usage} /></div>
    <div className="activity-controls">
      <button disabled={!!busy || terminal || paused} onClick={() => void control('task.pause')}>{busy === 'task.pause' ? 'Pausing safely…' : 'Pause'}</button>
      <button disabled={!!busy || terminal || data.status !== 'paused'} onClick={() => void control('task.resume')}>Resume</button>
      <button disabled={!!busy || terminal} onClick={() => void control('task.cancel')}>Cancel</button>
      <label>Rollback checkpoint<select aria-label="Rollback checkpoint" value={target} onChange={(event) => setCheckpoint(event.target.value)}>{data.checkpoints.map((c, i) => <option key={c.id} value={c.id}>{i + 1} · {c.files.join(', ') || 'read-only marker'} · {c.id}</option>)}</select></label>
      <button disabled={!!busy || !target} onClick={() => {
        if (window.confirm('Pause this task and restore file contents to before the selected tool call? Later file changes will be undone.')) void control('task.rollback', { task, checkpoint: target });
      }}>Roll back</button>
    </div>
    {(failure || error) && <p role="alert">{failure || error?.message}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="activity-resources">
      <div><h3>Task budget</h3>{data.budget ? <p>Soft {data.budget.softUsd === null ? 'not set' : money(data.budget.softUsd)} · Hard {data.budget.hardUsd === null ? 'not set' : money(data.budget.hardUsd)}<br />Tokens soft {data.budget.softTokens ?? 'not set'} · hard {data.budget.hardTokens ?? 'not set'}</p> : <p className="hint">No task limit configured</p>}<Usage usage={data.usage} /></div>
      <div><h3>Write leases</h3>{data.leases.length ? <ul aria-label="Write leases">{data.leases.map((lease) => <li key={lease.id} data-lease-state={lease.state}><strong>{lease.holder} · {lease.mode} · {lease.state}</strong><span>{lease.globs.join(', ')} · heartbeat {lease.heartbeat} · expires {lease.expiresAt}</span></li>)}</ul> : <p className="hint">No held write leases. Read-only tools do not acquire one.</p>}</div>
      <div><h3>Last checkpoint</h3><p>{data.checkpoints.at(-1)?.id ?? 'None yet'}</p><span className="hint">{data.checkpoints.length} durable tool boundaries</span></div>
    </div>
    {!!pending.length && <div className="approval"><strong>{pending.length} pending approval(s)</strong><p>{pending.map((a) => a.tool).join(', ')}</p><button disabled={!!busy} onClick={() => void approve(true)}>Approve all</button><button disabled={!!busy} onClick={() => void approve(false)}>Deny all</button></div>}
    <ol className="activity-branches" aria-label="Task agent activity tree">{data.agents.filter((a) => !a.parent).map((agent) => <AgentBranch key={agent.id} agent={agent} activity={data} />)}</ol>
  </section>;
}
