import type { Job } from "./types";

/**
 * Keys that, anywhere in a job's payload/result, are known to carry a
 * server-local filesystem path (or could) rather than data safe to hand to
 * a client — mirrors the no-server-path-leak rule already applied to
 * export_jobs/the export API elsewhere in this codebase.
 */
const PATH_LIKE_KEYS = new Set([
  "sourcePath",
  "localFilePath",
  "outputPath",
  "mediaPath",
  "storedPath",
  "assPath",
  "path",
  "filePath",
  "inputMediaPath",
]);

const REDACTED = "[chemin serveur masqué]";

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_LIKE_KEYS.has(key)) {
        out[key] = typeof val === "string" ? REDACTED : val;
        continue;
      }
      out[key] = redactValue(val);
    }
    return out;
  }
  return value;
}

/** Shape returned by every job-facing API route: never a raw server path, never a secret. */
export interface RedactedJob {
  id: string;
  projectId: string | null;
  kind: Job["kind"];
  status: Job["status"];
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

export function redactJobForResponse(job: Job): RedactedJob {
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    payload: redactValue(job.payload),
    result: job.result !== null ? redactValue(job.result) : null,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    idempotencyKey: job.idempotencyKey,
  };
}
