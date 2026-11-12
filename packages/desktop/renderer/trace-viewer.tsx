import { t } from "./i18n";
import type { TraceSpan } from '@helix/protocol';
import { useRpc } from './rpc';

function SpanBranch({ span, spans, ancestors = [] }: { span: TraceSpan; spans: TraceSpan[]; ancestors?: string[] }) {
  const seen = [...ancestors, span.spanId];
  const children = spans.filter((child) => child.traceId === span.traceId && child.parentSpanId === span.spanId && !seen.includes(child.spanId));
  return <li data-span={span.spanId} data-span-name={span.name}>
    <details open>
      <summary><strong>{span.name}</strong> {t("_588da4")}{span.durationMs.toFixed(2)} {t("_ms_1c856d")}{span.statusCode === 2 ? t("error_54a0e8") : span.statusCode === 1 ? t("ok_565339") : t("unset_8d2dd4")}</summary>
      {span.statusMessage && <p role="status">{span.statusMessage}</p>}
      <details><summary>{t("span_attributes_and_events_e16478")}</summary><pre tabIndex={0}>{JSON.stringify({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, attributes: span.attributes, events: span.events }, null, 2)}</pre></details>
      {children.length > 0 && <ol>{children.map((child) => <SpanBranch key={child.spanId} span={child} spans={spans} ancestors={seen} />)}</ol>}
    </details>
  </li>;
}
export function TraceViewer({ task }: { task: string }) {
  const trace = useRpc<{ spans: TraceSpan[] }>('trace.get', { task }, !!task);
  const spans = trace.data?.spans ?? [];
  const roots = spans.filter((span) => !span.parentSpanId || !spans.some((parent) => parent.traceId === span.traceId && parent.spanId === span.parentSpanId));
  return <section className="trace-viewer" aria-label={t("local_trace_viewer_29fd95")}>
    <div className="toolbar"><h2>{t("local_trace_viewer_29fd95")}</h2><button disabled={!task} onClick={() => void trace.refetch()}>{t("refresh_trace_7b24cf")}</button></div>
    {!task ? <p>{t("select_a_task_to_inspect_its_trace_4a6430")}</p> : trace.error ? <p role="alert">{trace.error.message}</p> : trace.isPending ? <p role="status">{t("loading_trace_5edd83")}</p> : spans.length ? <ol aria-label={t("trace_span_tree_1dd415")}>{roots.map((span) => <SpanBranch key={span.spanId} span={span} spans={spans} />)}</ol> : <p>{t("no_completed_spans_for_this_task_yet_bca43f")}</p>}
  </section>;
}
