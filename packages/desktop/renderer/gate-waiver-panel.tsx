import { t } from "./i18n";
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { rpc, useRpc, queryClient } from "./rpc";

type GateFailure = { id: string; data: { attempt: number; gates: { name: string; command: string }[] } };

export function GateWaiverPanel({ task }: { task: string }) {
  const failures = useRpc<GateFailure[]>("artifact.list", { task, kind: "gate_failure" }, true);
  const waivers = useRpc<{ id: string; data: { reason: string; by: string } }[]>("artifact.list", { task, kind: "gate_waiver" }, true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const failure = failures.data?.at(-1);
  if (!failure) return null;
  const waiver = waivers.data?.at(-1);
  if (waiver) {
    return (
      <section className="plan-review" aria-label={t("gate_waiver_a9c7c7")}>
        <p role="status" className="agent-note">
          {t("waived_by_43d2e4")}{waiver.data.by}{t("_45822f")}{waiver.data.reason}
        </p>
      </section>
    );
  }
  const waive = async () => {
    setBusy(true);
    setError("");
    try {
      await rpc.call("gate.waive", { task, reason });
      await queryClient.invalidateQueries();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="plan-review" aria-label={t("gate_waiver_a9c7c7")}>
      <header>
        <strong>
          <ShieldAlert size={14} /> {t("_required_gates_are_still_red_f14510")}</strong>
      </header>
      <ul>
        {failure.data.gates.map((gate) => (
          <li key={gate.name}>
            {gate.name}{t("_45822f")}<code>{gate.command}</code>
          </li>
        ))}
      </ul>
      <label>
        <span className="subtle">{t("why_is_it_acceptable_to_finish_anyway_this_is_8c6ce0")}</span>
        <textarea value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} aria-label={t("waiver_reason_f0ff7a")} />
      </label>
      <div className="plan-actions">
        <button type="button" disabled={busy || !reason.trim()} onClick={() => void waive()}>
          {t("waive_and_mark_done_daddd6")}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
