import { parseJobListResponse, parseJobResponse, type ParsedJob } from "./parseJobResponse";
import { readChainSteps, type AutoPipelineOptions } from "./chain";
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
  /**
   * Asks the server to run the rest of the automatic pipeline after this
   * job (see lib/jobs/chain). The follow-up steps are built server-side;
   * this only says "continue, with these options".
   */
  pipeline?: AutoPipelineOptions | true;
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

/**
 * 30 minutes at the default interval. The jobs behind this are real work
 * on real media — a yt-dlp download of a long video, an ffmpeg render, a
 * speech-to-text pass over twenty minutes of audio — and the previous
 * 3-minute ceiling gave up on all of them while they were still running,
 * reporting a failure for a job that went on to succeed.
 */
const DEFAULT_MAX_POLL_ATTEMPTS = 1200;

export interface PollJobOptions {
  intervalMs?: number;
  /** Bounded: polling always stops after this many checks even if the job never reaches a terminal status. */
  maxAttempts?: number;
  onUpdate?: (job: ParsedJob) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function pollJobUntilDone(jobId: string, options: PollJobOptions = {}): Promise<ParsedJob> {
  const { intervalMs = 1500, maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS, onUpdate, signal, fetchImpl = fetch } = options;

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

/**
 * The job the worker enqueued as the continuation of `jobId`, or null
 * while it does not exist yet (or the chain ended there).
 *
 * Found by the idempotency key the worker derives from the finished job's
 * own id — the one piece of information that ties two rows of the queue
 * together without the client having to guess at kinds or timestamps.
 */
export async function fetchChainedJobOf(
  projectId: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ParsedJob | null> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/projects/${projectId}/jobs`, { cache: "no-store" });
  } catch {
    throw new JobClientError("Impossible de contacter le serveur pour suivre l'enchaînement.");
  }
  const json = await parseJsonOrNull(response);
  const ok = json && typeof json === "object" && (json as { ok?: unknown }).ok === true;
  if (!response.ok || !ok) {
    const message = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
    throw new JobClientError(typeof message === "string" ? message : "Jobs du projet introuvables.");
  }
  return parseJobListResponse(json).find((job) => job.idempotencyKey === `chain:${jobId}`) ?? null;
}

export interface RunPipelineOptions extends RunJobOptions {
  /** Called once per step as soon as it is known, then on each of its updates. */
  onStep?: (job: ParsedJob) => void;
  /**
   * How long to wait for the worker to pick up the next step before
   * concluding the chain is over. Generous: the worker may be busy with
   * another project's job when this one finishes.
   */
  chainLookupAttempts?: number;
}

/**
 * Runs a whole automatic pipeline and resolves with every step it ran, in
 * order — the client-side counterpart of the worker's chaining.
 *
 * It follows the chain rather than assuming it: each step is discovered
 * from the previous one's id, so the UI shows the steps the server
 * actually ran. A step that fails ends the walk, and the returned list
 * ends on that failed job — which is exactly what the user needs to see.
 */
export async function runPipeline(
  params: EnqueueJobParams,
  options: RunPipelineOptions = {}
): Promise<ParsedJob[]> {
  const { onStep, chainLookupAttempts: _lookups, ...jobOptions } = options;
  const first = await runJob(params, {
    ...jobOptions,
    onUpdate: (job) => {
      options.onUpdate?.(job);
      onStep?.(job);
    },
  });
  return followPipeline(params.projectId, first, options);
}

/**
 * Follows a pipeline whose first job was enqueued elsewhere — by
 * /api/download-youtube, when a pasted link starts the whole chain — and
 * resolves with every step it ran, `first` included, exactly like
 * runPipeline. `first` may still be running.
 */
export async function followPipeline(
  projectId: string,
  first: ParsedJob,
  options: RunPipelineOptions = {}
): Promise<ParsedJob[]> {
  const { onStep, chainLookupAttempts = 20, ...jobOptions } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? 1500;

  const steps: ParsedJob[] = [];
  onStep?.(first);
  let current = TERMINAL_STATUSES.includes(first.status)
    ? first
    : await pollJobUntilDone(first.id, {
        ...jobOptions,
        onUpdate: (job) => {
          options.onUpdate?.(job);
          onStep?.(job);
        },
      });
  steps.push(current);

  // A job whose payload carries no remaining step was the last one: there
  // is no continuation to wait for, and looking for one would hold the UI
  // for chainLookupAttempts × intervalMs after the work is already done.
  while (current.status === "succeeded" && readChainSteps(current.payload).length > 0) {
    if (options.signal?.aborted) break;

    let next: ParsedJob | null = null;
    for (let attempt = 0; attempt < chainLookupAttempts && !next; attempt++) {
      next = await fetchChainedJobOf(projectId, current.id, fetchImpl);
      if (!next) await sleep(intervalMs, options.signal);
      if (options.signal?.aborted) break;
    }
    if (!next) break;

    onStep?.(next);
    current = await pollJobUntilDone(next.id, {
      ...jobOptions,
      onUpdate: (job) => {
        options.onUpdate?.(job);
        onStep?.(job);
      },
    });
    steps.push(current);
  }

  return steps;
}
