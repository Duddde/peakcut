import { CHAIN_PAYLOAD_KEY, type AutoPipelineOptions } from "./chain";
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
  /**
   * Present when the caller asked for the automatic pipeline to continue
   * after this job (see lib/jobs/chain). The follow-up steps themselves
   * are built server-side from this request — never taken from the body.
   */
  pipeline: AutoPipelineOptions | null;
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

  // The chain decides what else runs, under this project, without passing
  // back through this route's ownership and quota checks. It is therefore
  // built from `pipeline` on the server and never accepted from a client.
  if (body.payload && typeof body.payload === "object" && CHAIN_PAYLOAD_KEY in (body.payload as object)) {
    throw new JobInputParseError(
      `payload.${CHAIN_PAYLOAD_KEY} est réservé : demandez l'enchaînement avec "pipeline".`
    );
  }

  const pipeline = parsePipeline(body.pipeline);

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
    pipeline,
  };
}

/**
 * `pipeline` asks for the rest of the automatic pipeline to follow this
 * job: `true` for its defaults, or an object to name the transcription
 * provider and tracking engine it should use.
 */
function parsePipeline(raw: unknown): AutoPipelineOptions | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new JobInputParseError("pipeline doit valoir true ou être un objet d'options.");
  }

  const options = raw as Record<string, unknown>;
  const result: AutoPipelineOptions = {};

  for (const key of ["providerId", "trackProvider"] as const) {
    if (options[key] === undefined) continue;
    if (typeof options[key] !== "string" || (options[key] as string).trim().length === 0) {
      throw new JobInputParseError(`pipeline.${key} doit être une chaîne non vide.`);
    }
    result[key] = (options[key] as string).trim();
  }

  if (options.resegment !== undefined) {
    if (typeof options.resegment !== "boolean") {
      throw new JobInputParseError("pipeline.resegment doit être un booléen.");
    }
    result.resegment = options.resegment;
  }

  return result;
}
