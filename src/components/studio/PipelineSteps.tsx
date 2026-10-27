import { AUTO_PIPELINE_ORDER } from "@/lib/jobs/chain";
import type { JobKind } from "@/lib/jobs/types";

/** What each automatic-pipeline step is called, in the user's words rather than the queue's. */
export const PIPELINE_STEP_LABELS: Record<JobKind, string> = {
  download: "Téléchargement de la vidéo",
  transcription: "Transcription mot à mot",
  analysis: "Découpage et classement des clips",
  tracking: "Cadrage sur le visage",
  render: "Export",
  motion: "Motion design (Claude)",
};

export interface PipelineStepView {
  kind: JobKind;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
}

/**
 * The steps the pipeline is expected to run, shown before anything has
 * started so the user knows what they just asked for. They are replaced
 * by the real jobs as those appear — the plan is a label, never the
 * source of truth about what ran.
 */
export function plannedPipelineSteps(startKind: JobKind, options: { motion?: boolean } = {}): PipelineStepView[] {
  const from = AUTO_PIPELINE_ORDER.indexOf(startKind);
  const kinds = (from < 0 ? [startKind] : AUTO_PIPELINE_ORDER.slice(from)).filter(
    (kind) => kind !== "motion" || options.motion
  );
  return kinds.map((kind) => ({ kind, status: "pending", progress: 0 }));
}

export function mergePipelineStep(
  steps: PipelineStepView[],
  job: { kind: JobKind; status: string; progress: number }
): PipelineStepView[] {
  const status: PipelineStepView["status"] =
    job.status === "queued" ? "pending" : (job.status as PipelineStepView["status"]);
  const updated = { kind: job.kind, status, progress: job.progress };
  const index = steps.findIndex((step) => step.kind === job.kind);
  if (index < 0) return [...steps, updated];
  return steps.map((step, i) => (i === index ? updated : step));
}

export function PipelineSteps({ steps }: { steps: PipelineStepView[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((step) => (
        <li key={step.kind} className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              step.status === "succeeded"
                ? "bg-emerald-400"
                : step.status === "running"
                  ? "bg-amber-300"
                  : step.status === "failed" || step.status === "cancelled"
                    ? "bg-rose-400"
                    : "bg-zinc-600"
            }`}
          />
          <span className={step.status === "pending" ? "text-zinc-500" : "text-zinc-300"}>
            {PIPELINE_STEP_LABELS[step.kind]}
          </span>
          <span className="text-zinc-600">
            {step.status === "running"
              ? `${step.progress}%`
              : step.status === "succeeded"
                ? "terminé"
                : step.status === "failed"
                  ? "échec"
                  : step.status === "cancelled"
                    ? "annulé"
                    : "en attente"}
          </span>
        </li>
      ))}
    </ol>
  );
}
