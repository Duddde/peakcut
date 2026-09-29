export type JobKind = "download" | "transcription" | "analysis" | "tracking" | "render";

export const JOB_KINDS: JobKind[] = ["download", "transcription", "analysis", "tracking", "render"];

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

/**
 * A durable unit of background work. `payload`/`result` are opaque to the
 * repository — each job kind's handler owns its own shape (see
 * src/lib/jobs/handlers.ts) — but are always JSON-serializable, never raw
 * binary, and routes must redact server paths before returning either to a
 * client (see src/lib/jobs/redactJob.ts).
 */
export interface Job {
  id: string;
  projectId: string | null;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  idempotencyKey: string | null;
}

export interface NewJobInput {
  id: string;
  projectId: string | null;
  kind: JobKind;
  payload: unknown;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  now: string;
}

export interface CreateJobResult {
  job: Job;
  /** False when an existing job with the same idempotency_key was returned instead of inserting a new row. */
  created: boolean;
}

export interface FailJobResult {
  /** True when the job was requeued (status back to "queued") because attempts remained; false when it was terminally failed. */
  requeued: boolean;
  /** False when the job was not in "running" state (e.g. already cancelled) and no update was applied. */
  applied: boolean;
}
