import type { DatabaseSync } from "node:sqlite";
import type { CreateJobResult, FailJobResult, Job, JobKind, NewJobInput } from "./types";

export interface JobRepository {
  createJob(input: NewJobInput): CreateJobResult;
  getJobById(id: string): Job | null;
  /** Owner of the job's project, or null when the job has no project or the project no longer exists. */
  getJobOwnerId(id: string): string | null;
  listJobsByProject(projectId: string): Job[];
  /** Atomically claims and marks "running" the oldest queued job (optionally restricted to `kinds`), or null if none is queued. */
  claimNextJob(kinds?: JobKind[]): Job | null;
  updateProgress(id: string, progress: number, now: string): boolean;
  succeedJob(id: string, result: unknown, now: string): boolean;
  failJob(id: string, errorCode: string, errorMessage: string, now: string): FailJobResult;
  cancelJob(id: string, now: string): boolean;
}

interface JobRow {
  id: string;
  project_id: string | null;
  kind: string;
  status: string;
  progress: number;
  attempts: number;
  max_attempts: number;
  payload_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  idempotency_key: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as JobKind,
    status: row.status as Job["status"],
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    idempotencyKey: row.idempotency_key,
  };
}

/**
 * Local, Redis-free job queue backed by SQLite: the `jobs` table is both
 * the queue and the durable status record. Every state transition that
 * matters for correctness (idempotent create, claim, terminal
 * succeed/fail/cancel) runs inside a `BEGIN IMMEDIATE` transaction, which
 * takes SQLite's write lock immediately rather than on first write — this
 * is what makes `claimNextJob` safe to call concurrently from multiple
 * worker processes without two workers ever claiming the same row.
 */
export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  createJob(input: NewJobInput): CreateJobResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existingRow = this.db
          .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as JobRow | undefined;
        if (existingRow) {
          this.db.exec("COMMIT");
          return { job: rowToJob(existingRow), created: false };
        }
      }

      const maxAttempts = input.maxAttempts ?? 3;
      this.db
        .prepare(
          `INSERT INTO jobs (id, project_id, kind, status, progress, attempts, max_attempts, payload_json, result_json, error_code, error_message, created_at, updated_at, started_at, finished_at, idempotency_key)
           VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`
        )
        .run(
          input.id,
          input.projectId,
          input.kind,
          maxAttempts,
          JSON.stringify(input.payload),
          input.now,
          input.now,
          input.idempotencyKey ?? null
        );
      this.db.exec("COMMIT");
      const created = this.getJobById(input.id);
      if (!created) {
        throw new Error("Échec interne : le job venant d'être créé est introuvable.");
      }
      return { job: created, created: true };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getJobById(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getJobOwnerId(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT p.owner_id AS owner_id
         FROM jobs j JOIN projects p ON p.id = j.project_id
         WHERE j.id = ?`
      )
      .get(id) as { owner_id: string } | undefined;
    return row ? row.owner_id : null;
  }

  listJobsByProject(projectId: string): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  claimNextJob(kinds?: JobKind[]): Job | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const kindFilter = kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const row = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'queued'${kindFilter} ORDER BY created_at ASC LIMIT 1`)
        .get(...(kinds ?? [])) as JobRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'"
        )
        .run(now, now, row.id);
      this.db.exec("COMMIT");
      return this.getJobById(row.id);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  updateProgress(id: string, progress: number, now: string): boolean {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    const result = this.db
      .prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(clamped, now, id);
    return Number(result.changes) > 0;
  }

  succeedJob(id: string, result: unknown, now: string): boolean {
    const updateResult = this.db
      .prepare(
        "UPDATE jobs SET status = 'succeeded', progress = 100, result_json = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(JSON.stringify(result), now, now, id);
    return Number(updateResult.changes) > 0;
  }

  failJob(id: string, errorCode: string, errorMessage: string, now: string): FailJobResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT attempts, max_attempts, status FROM jobs WHERE id = ?").get(id) as
        | { attempts: number; max_attempts: number; status: string }
        | undefined;
      if (!row || row.status !== "running") {
        this.db.exec("COMMIT");
        return { requeued: false, applied: false };
      }
      if (row.attempts < row.max_attempts) {
        this.db
          .prepare(
            "UPDATE jobs SET status = 'queued', error_code = ?, error_message = ?, updated_at = ?, started_at = NULL WHERE id = ?"
          )
          .run(errorCode, errorMessage, now, id);
        this.db.exec("COMMIT");
        return { requeued: true, applied: true };
      }
      this.db
        .prepare(
          "UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?"
        )
        .run(errorCode, errorMessage, now, now, id);
      this.db.exec("COMMIT");
      return { requeued: false, applied: true };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  cancelJob(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE jobs SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')"
      )
      .run(now, now, id);
    return Number(result.changes) > 0;
  }
}
