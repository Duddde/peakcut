import type { DatabaseSync } from "node:sqlite";
import { SqliteJobRepository, type JobRepository } from "@/lib/jobs/JobRepository";
import { createDefaultJobHandlers } from "@/lib/jobs/handlers";
import type { JobHandlers } from "@/lib/jobs/worker";
import { cleanupExpiredTrials, resolveTrialStorageRoots } from "@/lib/publicTrial/cleanup";

/**
 * How often a long-running worker sweeps expired public-trial projects
 * (and their files). Expired trials are also swept on each new trial
 * start, so this interval only covers the case where nobody starts one.
 */
export const TRIAL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface JobWorkerRuntime {
  repo: JobRepository;
  handlers: JobHandlers;
  exportsBaseDir: string;
  downloadsBaseDir: string;
  /** Deletes every expired public trial and its files. Returns how many were removed. */
  sweepExpiredTrials: () => Promise<number>;
}

/**
 * Everything a job worker needs besides the loop itself, wired from the
 * environment: the queue repository, the real handlers, the storage dirs
 * and the public-trial sweep.
 *
 * Shared by both entry points — the standalone process
 * (scripts/run-job-worker.ts) and the in-server worker
 * (src/lib/jobs/inlineWorker.ts) — so the two can never drift into
 * handling jobs with different storage roots or different handler sets.
 *
 * The caller provides the database: a plain Node process opens its own,
 * while inside Next.js the connection is the app's shared one.
 */
export function createJobWorkerRuntime(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): JobWorkerRuntime {
  const roots = resolveTrialStorageRoots(env, cwd);
  const { exportsBaseDir, downloadsBaseDir } = roots;

  return {
    repo: new SqliteJobRepository(db),
    handlers: createDefaultJobHandlers({ db, exportsBaseDir, downloadsBaseDir }),
    exportsBaseDir,
    downloadsBaseDir,
    // Runs whatever PEAKCUT_PUBLIC_TRIAL says: turning the flag off must
    // not strand data that was created while it was on.
    sweepExpiredTrials: () => cleanupExpiredTrials(db, { roots }),
  };
}
