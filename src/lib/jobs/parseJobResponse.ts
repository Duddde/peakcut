import { JOB_KINDS, JOB_STATUSES, type JobKind, type JobStatus } from "./types";

export class JobResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse de job invalide : ${message}`);
    this.name = "JobResponseParseError";
  }
}

export interface ParsedJob {
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

function obj(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new JobResponseParseError(`${field} doit être un objet.`);
  }
  return raw as Record<string, unknown>;
}

function str(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new JobResponseParseError(`${field} doit être une chaîne.`);
  }
  return raw;
}

function nullableStr(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  return str(raw, field);
}

function num(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new JobResponseParseError(`${field} doit être un nombre.`);
  }
  return raw;
}

/** Client-side defensive boundary parse of a single job payload, e.g. `{ ok, job }`. */
export function parseJobResponse(raw: unknown): ParsedJob {
  const envelope = obj(raw, "réponse");
  const j = obj(envelope.job, "job");

  if (typeof j.kind !== "string" || !JOB_KINDS.includes(j.kind as JobKind)) {
    throw new JobResponseParseError(`job.kind doit être l'un de : ${JOB_KINDS.join(", ")}.`);
  }
  if (typeof j.status !== "string" || !JOB_STATUSES.includes(j.status as JobStatus)) {
    throw new JobResponseParseError(`job.status doit être l'un de : ${JOB_STATUSES.join(", ")}.`);
  }

  return {
    id: str(j.id, "job.id"),
    projectId: nullableStr(j.projectId, "job.projectId"),
    kind: j.kind as JobKind,
    status: j.status as JobStatus,
    progress: num(j.progress, "job.progress"),
    attempts: num(j.attempts, "job.attempts"),
    maxAttempts: num(j.maxAttempts, "job.maxAttempts"),
    payload: j.payload ?? null,
    result: j.result ?? null,
    errorCode: nullableStr(j.errorCode, "job.errorCode"),
    errorMessage: nullableStr(j.errorMessage, "job.errorMessage"),
    createdAt: str(j.createdAt, "job.createdAt"),
    updatedAt: str(j.updatedAt, "job.updatedAt"),
    startedAt: nullableStr(j.startedAt, "job.startedAt"),
    finishedAt: nullableStr(j.finishedAt, "job.finishedAt"),
    idempotencyKey: nullableStr(j.idempotencyKey, "job.idempotencyKey"),
  };
}
