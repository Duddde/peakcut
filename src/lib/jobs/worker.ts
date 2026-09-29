import type { JobRepository } from "./JobRepository";
import type { Job, JobKind } from "./types";

export interface JobHandlerContext {
  job: Job;
  /** Persists progress (0..100) for this job; silently ignored if the job was cancelled out from under it. */
  reportProgress: (percent: number) => void;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<unknown>;

export interface JobHandlers {
  download: JobHandler;
  transcription: JobHandler;
  analysis: JobHandler;
  tracking: JobHandler;
  render: JobHandler;
}

export interface RunJobWorkerOptions {
  repo: JobRepository;
  handlers: JobHandlers;
  /** Restrict this worker to specific job kinds; omit to handle all kinds. */
  kinds?: JobKind[];
  /** Delay between empty polls when not in `once` mode. Defaults to 1000ms. */
  pollIntervalMs?: number;
  /** Process at most one claim attempt then return, instead of looping. Used by `--once` and by tests. */
  once?: boolean;
  /** Hard cap on loop iterations, as a last-resort safety net against an infinite loop even outside `once` mode. */
  maxIterations?: number;
  /** Cooperative shutdown signal — checked between iterations and during idle sleeps. */
  signal?: AbortSignal;
  now?: () => string;
}

export interface RunJobWorkerResult {
  processed: number;
  iterations: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * The queue-draining loop shared by both `--once` (tests, cron-style
 * invocation) and long-running (`systemd`) modes. It never imports
 * anything Next.js-specific — this runs as a plain Node process, entirely
 * separate from the request/response lifecycle, so a stuck or slow job
 * never ties up an HTTP worker thread.
 *
 * Each claimed job is dispatched to the handler matching its `kind`; a
 * thrown error is caught here and turned into `failJob` (which itself
 * decides retry vs. terminal failure by attempts/maxAttempts) — a handler
 * never needs to know about retry policy.
 */
export async function runJobWorker(options: RunJobWorkerOptions): Promise<RunJobWorkerResult> {
  const {
    repo,
    handlers,
    kinds,
    pollIntervalMs = 1000,
    once = false,
    maxIterations = Infinity,
    signal,
    now = () => new Date().toISOString(),
  } = options;

  let processed = 0;
  let iterations = 0;

  while (!signal?.aborted && iterations < maxIterations) {
    iterations++;

    const job = repo.claimNextJob(kinds);
    if (!job) {
      if (once) break;
      await sleep(pollIntervalMs, signal);
      continue;
    }

    const handler = handlers[job.kind];
    try {
      const result = await handler({
        job,
        reportProgress: (percent) => {
          repo.updateProgress(job.id, percent, now());
        },
      });
      repo.succeedJob(job.id, result ?? null, now());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error ? err.name : "UnknownError";
      repo.failJob(job.id, errorCode, errorMessage, now());
    }
    processed++;

    if (once) break;
  }

  return { processed, iterations };
}
