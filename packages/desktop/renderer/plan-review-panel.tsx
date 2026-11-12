import { t } from "./i18n";
import { useEffect, useState } from "react";
import { Check, Plus, Save, Trash2 } from "lucide-react";
import { rpc, useRpc, queryClient } from "./rpc";
import { useWorkbench } from "./state";

type PlanStep = {
  id: string;
  description: string;
  writeSet: string[];
  dependsOn: string[];
  gates: string[];
};
type PlanReview = {
  task: string;
  status: string;
  plan: {
    id: string;
    revision: number;
    data: {
      goal: string;
      steps: PlanStep[];
      risks?: string[];
      verification?: string[];
      openQuestions?: string[];
    };
  } | null;
  approved: boolean;
  executionTask: string | null;
};

const splitPaths = (value: string) =>
  value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);

export function PlanReviewPanel({ task }: { task: string }) {
  const review = useRpc<PlanReview>("plan.get", { task }, true);
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const planId = review.data?.plan?.id;
  useEffect(() => {
    if (review.data?.plan) {
      setSteps(review.data.plan.data.steps);
      setDirty(false);
    }
  }, [planId, review.data?.plan]);
  if (!review.data?.plan) return null;
  const { plan, approved, executionTask } = review.data;
  const edit = (index: number, patch: Partial<PlanStep>) => {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
    setDirty(true);
  };
  const remove = (index: number) => {
    const removed = steps[index].id;
    setSteps((current) =>
      current
        .filter((_, i) => i !== index)
        .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((id) => id !== removed) })),
    );
    setDirty(true);
  };
  const add = () => {
    let n = steps.length + 1;
    while (steps.some((step) => step.id === "s" + n)) n += 1;
    setSteps((current) => [...current, { id: "s" + n, description: "", writeSet: [], dependsOn: [], gates: [] }]);
    setDirty(true);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await rpc.call("plan.update", { task, planId: plan.id, edit: { steps } });
      await queryClient.invalidateQueries({ queryKey: ["plan.get"] });
    });
  const approve = () =>
    run(async () => {
      const result = await rpc.call<PlanReview>("plan.approve", { task, planId: plan.id });
      await queryClient.invalidateQueries({ queryKey: ["plan.get"] });
      void queryClient.invalidateQueries({ queryKey: ["task.monitor"] });
      if (result.executionTask) useWorkbench.getState().setTask(result.executionTask);
    });
  return (
    <section className="plan-review" aria-label={t("plan_review_649e8b")}>
      <header>
        <strong>{t("plan_review_649e8b")}</strong>
        <span className="subtle">{t("revision_e330d8")}{plan.revision}</span>
      </header>
      <p>{plan.data.goal}</p>
      {approved ? (
        <p role="status" className="agent-note">
          <Check size={13} />
          {t("approved_execution_task_e28335")}{executionTask} {t("_is_running_92039f")}</p>
      ) : (
        <p className="subtle">{t("nothing_can_write_files_until_you_approve_thi_8b741a")}</p>
      )}
      <ol className="plan-steps">
        {steps.map((step, index) => (
          <li key={step.id}>
            <label>
              <span className="subtle">{t("step_474a98")}{step.id}</span>
              <textarea
                aria-label={t("description_of_step_08c51c") + step.id}
                value={step.description}
                disabled={approved || busy}
                onChange={(event) => edit(index, { description: event.target.value })}
              />
            </label>
            <label>
              <span className="subtle">{t("files_it_may_write_comma_separated_81ee79")}</span>
              <input
                aria-label={t("files_written_by_step_21de41") + step.id}
                defaultValue={step.writeSet.join(", ")}
                key={plan.id + step.id}
                disabled={approved || busy}
                onChange={(event) => edit(index, { writeSet: splitPaths(event.target.value) })}
              />
            </label>
            {!approved && (
              <button type="button" aria-label={t("remove_step_2d8ce3") + step.id} disabled={busy} onClick={() => remove(index)}>
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
      {!!plan.data.risks?.length && (
        <details>
          <summary>{t("risks_bb6857")}</summary>
          <ul>
            {plan.data.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </details>
      )}
      {!!plan.data.openQuestions?.length && (
        <details open>
          <summary>{t("open_questions_5e0a96")}</summary>
          <ul>
            {plan.data.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </details>
      )}
      {!approved && (
        <div className="plan-actions">
          <button type="button" disabled={busy} onClick={add}>
            <Plus size={14} />
            {t("add_step_9289d4")}</button>
          <button type="button" disabled={busy || !dirty} onClick={() => void save()}>
            <Save size={14} />
            {t("save_edits_259560")}</button>
          <button type="button" className="primary" disabled={busy || dirty} onClick={() => void approve()}>
            <Check size={14} />
            {t("approve_and_run_84dbea")}</button>
        </div>
      )}
      {dirty && !approved && <p className="subtle">{t("save_your_edits_before_approving_76076f")}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
