"use client";

import type { JobStatus } from "@/lib/jobs/types";

export interface JobProgressState {
  status: JobStatus;
  progress: number;
  errorMessage?: string | null;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "En file d'attente…",
  running: "En cours…",
  succeeded: "Terminé.",
  failed: "Échec.",
  cancelled: "Annulé.",
};

/**
 * Accessible progress/status readout for a background job, shared by every
 * long-running studio action (transcription/analysis/tracking/render).
 * `label` identifies which action this is, for the accessible name — with
 * several long-running actions on screen at once, a bare "Statut" would be
 * ambiguous to a screen-reader user.
 */
export function JobProgress({
  label,
  job,
  onCancel,
  canCancel,
}: {
  label: string;
  job: JobProgressState | null;
  onCancel?: () => void;
  canCancel?: boolean;
}) {
  if (!job) return null;

  const isTerminal = job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
  const isError = job.status === "failed";

  return (
    <div className="space-y-2" data-testid={`job-progress-${label}`}>
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label={`Progression : ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job.progress}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"
        >
          <div
            className={`h-full rounded-full transition-all ${isError ? "bg-rose-400" : "bg-amber-400"}`}
            style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
          />
        </div>
        {!isTerminal && canCancel && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1 text-xs text-zinc-300 transition hover:border-rose-400/50 hover:text-rose-300"
          >
            Annuler
          </button>
        )}
      </div>
      <p
        role="status"
        aria-live="polite"
        aria-label={`Statut : ${label}`}
        className={`text-xs ${isError ? "text-rose-300" : job.status === "succeeded" ? "text-emerald-300" : "text-zinc-500"}`}
      >
        {STATUS_LABEL[job.status]}
        {job.errorMessage ? ` ${job.errorMessage}` : ""}
      </p>
    </div>
  );
}
