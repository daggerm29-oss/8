import { useState } from 'react';
import { LEDGER_DIMENSIONS, type LedgerDashboard, type LedgerDimension } from '@helix/protocol';
import { rpc, useRpc } from './rpc';
import { useWorkbench, type Task } from './state';
import { t, formatMoney } from './i18n';
import { TraceViewer } from './trace-viewer';

export function LedgerPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const dimensions = { agent: t("agent_11b39c"), task: t("task_4bc74b"), tool: t("tool_2e53bd"), provider: t("provider_472590"), model: t("model_5e2c61") };
  const [task, setTask] = useState('');
  const [dimension, setDimension] = useState<LedgerDimension>('agent');
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const tasks = useRpc<Task[]>('task.monitor');
  const filter = { workspacePath: workspace, ...(task ? { task } : {}) };
  const dashboard = useRpc<LedgerDashboard>('ledger.dashboard', filter, !!workspace);
  const data = dashboard.data;
  const download = async (format: 'csv' | 'json') => {
    setExporting(true); setError('');
    try {
      const result = await rpc.call<{ content: string; mime: string; filename: string }>('ledger.export', { ...filter, format });
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
      const link = document.createElement('a'); link.href = url; link.download = result.filename;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { setError((error as Error).message); }
    finally { setExporting(false); }
  };
  return <section className="tool-panel ledger-panel" aria-label={t("ledger_dashboard_47c554")}>
    <div className="toolbar"><h2>{t("ledger_traces_bee3c3")}</h2><button disabled={!workspace} onClick={() => void dashboard.refetch()}>{t("refresh_ledger_17f25f")}</button><button disabled={!workspace || exporting} onClick={() => void download('csv')}>{t("export_csv_91f71c")}</button><button disabled={!workspace || exporting} onClick={() => void download('json')}>{t("export_json_ff2565")}</button></div>
    <div className="ledger-filters"><label>{t("task_4bc74b")}<select aria-label={t("ledger_task_d31d26")} value={task} onChange={(event) => setTask(event.target.value)}><option value="">{t("all_workspace_tasks_34d1c9")}</option>{tasks.data?.filter((item) => item.workspacePath === workspace).map((item) => <option key={item.id} value={item.id}>{item.title || item.goal}</option>)}</select></label><label>{t("group_by_956a51")}<select aria-label={t("ledger_grouping_7529b8")} value={dimension} onChange={(event) => setDimension(event.target.value as LedgerDimension)}>{LEDGER_DIMENSIONS.map((item) => <option key={item} value={item}>{dimensions[item]}</option>)}</select></label></div>
    {(error || dashboard.error) && <p role="alert">{error || dashboard.error?.message}</p>}
    {!workspace ? <p>{t("open_a_workspace_to_inspect_usage_a19fee")}</p> : !data ? <p role="status">{t("loading_ledger_289392")}</p> : <>
      <dl className="ledger-totals" aria-label={t("ledger_totals_445325")}><div><dt>{t("calls_b73a5e")}</dt><dd data-metric="calls">{data.totals.calls}</dd></div><div><dt>{t("input_tokens_dd856e")}</dt><dd data-metric="inputTokens">{data.totals.inputTokens}</dd></div><div><dt>{t("cached_input_876a43")}</dt><dd data-metric="cachedInputTokens">{data.totals.cachedInputTokens}</dd></div><div><dt>{t("output_tokens_a9b50e")}</dt><dd data-metric="outputTokens">{data.totals.outputTokens}</dd></div><div><dt>{t("reasoning_tokens_157b0f")}</dt><dd data-metric="reasoningTokens">{data.totals.reasoningTokens}</dd></div><div><dt>{t("known_cost_466b91")}</dt><dd data-metric="costUsd">{formatMoney(data.totals.costUsd)}</dd></div><div><dt>{t("unpriced_calls_f67c1b")}</dt><dd>{data.unknownCostCalls}</dd></div></dl>
      <p className="hint">{t("only_successful_calls_contribute_to_totals_un_45cffe")}</p>
      {dimension === 'tool' && <p className="hint">{t("tool_attribution_is_an_estimated_share_of_pro_291bdb")}</p>}
      <div className="ledger-table" role="region" aria-label={t("ledger_grouped_totals_560c35")} tabIndex={0}><table><caption>{t("usage_by_selected_dimension_50866d")}</caption><thead><tr><th scope="col">{t("group_34ca0e")}</th><th scope="col">{t("calls_b73a5e")}</th><th scope="col">{t("input_36ecb4")}</th><th scope="col">{t("cached_a251c1")}</th><th scope="col">{t("output_b2439b")}</th><th scope="col">{t("reasoning_d8211e")}</th><th scope="col">{t("known_cost_466b91")}</th><th scope="col">{t("unpriced_calls_f67c1b")}</th></tr></thead><tbody>{data.groups[dimension].map((group) => <tr key={group.key} data-ledger-group={group.key}><th scope="row">{group.key}</th>{[group.calls, group.inputTokens, group.cachedInputTokens, group.outputTokens, group.reasoningTokens].map((value, index) => <td key={index}>{value.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>)}<td>{formatMoney(group.costUsd)}</td><td>{group.unknownCostCalls.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td></tr>)}</tbody></table>{!data.groups[dimension].length && <p>{t("no_ledger_entries_for_this_selection_cd5dfa")}</p>}</div>
    </>}
    <TraceViewer task={task} />
  </section>;
}
