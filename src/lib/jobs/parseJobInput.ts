import { JOB_KINDS, type JobKind } from "./types";

export class JobInputParseError extends Error {
  constructor(message: string) {
    super(`Requête de job invalide : ${message}`);
    this.name = "JobInputParseError";
  }
}

const MAX_ATTEMPTS_CEILING = 10;

export interface CreateJobInput {
  projectId: string;
  kind: JobKind;
  payload: unknown;
  idempotencyKey: string | null;
  maxAttempts: number | undefined;
}

/**
 * Validates the generic envelope of a POST /api/jobs body. Payload
 * *contents* are intentionally left as opaque JSON here — each job kind's
 * handler is responsible for validating its own payload shape at run
 * time (see src/lib/jobs/handlers.ts), the same way route bodies are
 * validated independently of what ends up persisted.
 */
export function parseCreateJobInput(raw: unknown): CreateJobInput {
  if (typeof raw !== "object" || raw === null) {
    throw new JobInputParseError("le corps de la requête doit être un objet.");
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.projectId !== "string" || body.projectId.trim().length === 0) {
    throw new JobInputParseError("projectId est requis.");
  }

  if (typeof body.kind !== "string" || !JOB_KINDS.includes(body.kind as JobKind)) {
    throw new JobInputParseError(`kind doit être l'un de : ${JOB_KINDS.join(", ")}.`);
  }

  if ("payload" in body && (typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload))) {
    throw new JobInputParseError("payload doit être un objet.");
  }

  let idempotencyKey: string | null = null;
  if ("idempotencyKey" in body && body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim().length === 0) {
      throw new JobInputParseError("idempotencyKey doit être une chaîne non vide.");
    }
    idempotencyKey = body.idempotencyKey;
  }

  let maxAttempts: number | undefined;
  if ("maxAttempts" in body && body.maxAttempts !== undefined) {
    if (typeof body.maxAttempts !== "number" || !Number.isInteger(body.maxAttempts) || body.maxAttempts < 1) {
      throw new JobInputParseError("maxAttempts doit être un entier positif.");
    }
    if (body.maxAttempts > MAX_ATTEMPTS_CEILING) {
      throw new JobInputParseError(`maxAttempts ne peut pas dépasser ${MAX_ATTEMPTS_CEILING}.`);
    }
    maxAttempts = body.maxAttempts;
  }

  return {
    projectId: body.projectId,
    kind: body.kind as JobKind,
    payload: "payload" in body ? body.payload : {},
    idempotencyKey,
    maxAttempts,
  };
}
