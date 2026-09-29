import { parseJobResponse, type ParsedJob } from "./parseJobResponse";
import type { JobKind, JobStatus } from "./types";

export class JobClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobClientError";
  }
}

/** Thrown by pollJobUntilDone when a job never reaches a terminal status within the bounded number of checks. */
export class JobPollTimeoutError extends JobClientError {
  constructor(message: string) {
    super(message);
    this.name = "JobPollTimeoutError";
  }
}

const TERMINAL_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface EnqueueJobParams {
  projectId: string;
  kind: JobKind;
  payload?: unknown;
  /** Stable across retries of *this* logical action so a double-submit or a network retry never creates a duplicate job. */
  idempotencyKey?: string;
}

async function parseJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function enqueueJob(
  params: EnqueueJobParams,
  fetchImpl: typeof fetch = fetch
): Promise<ParsedJob> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.idempotencyKey ? { "idempotency-key": params.idempotencyKey } : {}),
      },
      body: JSON.stringify(params),
    });
  } catch {
    throw new JobClientError("Impossible de contacter le serveur pour créer le job.");
  }
  const json = await parseJsonOrNull(response);
  const ok = json && typeof json === "object" && (json as { ok?: unknown }).ok === true;
  if (!response.ok || !ok) {
    const message = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
    throw new JobClientError(typeof message === "string" ? message : "Échec de la création du job.");
  }
  return parseJobResponse(json);
}

export async function fetchJob(jobId: string, fetchImpl: typeof fetch = fetch): Promise<ParsedJob> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/jobs/${jobId}`, { cache: "no-store" });
  } catch {
    throw new JobClientError("Impossible de contacter le serveur pour suivre le job.");
  }
  const json = await parseJsonOrNull(response);
  const ok = json && typeof json === "object" && (json as { ok?: unknown }).ok === true;
  if (!response.ok || !ok) {
    const message = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
    throw new JobClientError(typeof message === "string" ? message : "Job introuvable.");
  }
  return parseJobResponse(json);
}

/** Requests cancellation; the route may still return the job (already terminal) alongside ok:false — that case is not an error here, just returned as-is. */
export async function requestJobCancel(jobId: string, fetchImpl: typeof fetch = fetch): Promise<ParsedJob> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  } catch {
    throw new JobClientError("Impossible de contacter le serveur pour annuler le job.");
  }
  const json = await parseJsonOrNull(response);
  if (json && typeof json === "object" && "job" in json) {
    return parseJobResponse(json);
  }
  const message = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
  throw new JobClientError(typeof message === "string" ? message : "Échec de l'annulation du job.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface PollJobOptions {
  intervalMs?: number;
  /** Bounded: polling always stops after this many checks even if the job never reaches a terminal status. */
  maxAttempts?: number;
  onUpdate?: (job: ParsedJob) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function pollJobUntilDone(jobId: string, options: PollJobOptions = {}): Promise<ParsedJob> {
  const { intervalMs = 1500, maxAttempts = 120, onUpdate, signal, fetchImpl = fetch } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new JobClientError("Suivi du job interrompu.");
    }
    const job = await fetchJob(jobId, fetchImpl);
    onUpdate?.(job);
    if (TERMINAL_STATUSES.includes(job.status)) {
      return job;
    }
    await sleep(intervalMs, signal);
  }

  throw new JobPollTimeoutError(
    `Le job "${jobId}" n'a pas terminé après ${maxAttempts} vérifications — il continue peut-être en arrière-plan, mais le suivi côté interface s'est arrêté.`
  );
}

export type RunJobOptions = PollJobOptions;

/** Enqueues then polls to completion — the single call StudioSection's action handlers use for every long-running operation. */
export async function runJob(params: EnqueueJobParams, options: RunJobOptions = {}): Promise<ParsedJob> {
  const job = await enqueueJob(params, options.fetchImpl);
  options.onUpdate?.(job);
  if (TERMINAL_STATUSES.includes(job.status)) {
    return job;
  }
  return pollJobUntilDone(job.id, options);
}
