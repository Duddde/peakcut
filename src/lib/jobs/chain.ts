import { JOB_KINDS, type Job, type JobKind } from "./types";

/**
 * Job chaining: how "paste a URL and get clips" is actually executed.
 *
 * The whole pipeline — fetch the video, transcribe it, cut and rank
 * candidate clips, frame them on the speaker — is not one long job. It is
 * the existing jobs, run in order, each enqueued by the worker when the
 * previous one succeeds. That choice is deliberate:
 *
 * - **Retries stay granular.** A transcription that fails on a provider
 *   hiccup retries the transcription, not the 400 MB download before it.
 * - **Progress stays legible.** The UI already lists jobs per project with
 *   their own progress; a chain shows up as the steps it really is,
 *   instead of one opaque bar sitting at 40% for ten minutes.
 * - **Failure stops the line.** Nothing downstream is enqueued, so the
 *   project is never left with clips cut from a transcript that was never
 *   produced. The error is the one of the step that actually broke.
 * - **It is durable.** The remaining steps live in the job row, so a
 *   worker restart in the middle of a pipeline resumes it rather than
 *   forgetting it.
 *
 * The chain is always built on the server (see parseCreateJobInput, which
 * refuses a client-supplied one): a caller asks for "the pipeline from
 * this step onward", never for an arbitrary list of follow-up work.
 */

/** Reserved payload key holding the steps still to run after this job. */
export const CHAIN_PAYLOAD_KEY = "__chain";

/**
 * The canonical order of the automatic pipeline. Each step needs what the
 * previous one writes to the project: transcription needs the downloaded
 * media file, analysis needs the transcript, tracking needs the segments
 * analysis produced (it rewrites each segment's crop).
 *
 * "motion" (Claude Motion) closes the pipeline when Claude is configured:
 * the cards are designed on the final clips, once cut and framed.
 *
 * "render" is deliberately absent. Rendering every candidate would spend
 * minutes of ffmpeg per clip on cuts the editor has not looked at yet —
 * and the point of the editor is that they get to change them first.
 */
export const AUTO_PIPELINE_ORDER: JobKind[] = ["download", "transcription", "analysis", "tracking", "motion"];

export interface ChainStep {
  kind: JobKind;
  payload: Record<string, unknown>;
}

export interface AutoPipelineOptions {
  /** Transcription provider id; required as soon as the chain includes the transcription step. */
  providerId?: string;
  /** Tracking engine for the framing step. Defaults to the auto-detecting "local-subject". */
  trackProvider?: string;
  /** Re-cut the segments from the transcript instead of only rescoring existing ones. */
  resegment?: boolean;
  /**
   * Add the Claude Motion step. Decided by the server (is Claude
   * configured?), never by the client: without a credential the step
   * could only fail, and the pipeline would end on an error after the
   * clips were in fact ready.
   */
  motion?: boolean;
}

export class ChainConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigurationError";
  }
}

/**
 * The steps that follow `fromKind` in the automatic pipeline.
 *
 * Starting from "transcription" (a project whose media is already on
 * disk) yields analysis + tracking; starting from "download" yields the
 * whole thing. A kind outside the pipeline — "render" — yields no steps:
 * exporting is an endpoint, never the start of a chain.
 */
export function buildAutoPipelineChain(fromKind: JobKind, options: AutoPipelineOptions = {}): ChainStep[] {
  const position = AUTO_PIPELINE_ORDER.indexOf(fromKind);
  if (position < 0) return [];

  const steps: ChainStep[] = [];
  for (const kind of AUTO_PIPELINE_ORDER.slice(position + 1)) {
    switch (kind) {
      case "transcription": {
        if (!options.providerId) {
          throw new ChainConfigurationError(
            "providerId est requis pour enchaîner la transcription : aucun transcript n'est fabriqué par défaut."
          );
        }
        steps.push({ kind, payload: { providerId: options.providerId } });
        break;
      }
      case "analysis":
        steps.push({ kind, payload: options.resegment ? { resegment: true } : {} });
        break;
      case "tracking":
        steps.push({ kind, payload: options.trackProvider ? { provider: options.trackProvider } : {} });
        break;
      case "motion":
        if (options.motion) steps.push({ kind, payload: {} });
        break;
      default:
        steps.push({ kind, payload: {} });
    }
  }
  return steps;
}

/** The payload a job carries when `steps` must run after it. */
export function attachChain(payload: Record<string, unknown>, steps: ChainStep[]): Record<string, unknown> {
  if (steps.length === 0) return payload;
  return { ...payload, [CHAIN_PAYLOAD_KEY]: steps };
}

function isChainStep(value: unknown): value is ChainStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  if (typeof step.kind !== "string" || !JOB_KINDS.includes(step.kind as JobKind)) return false;
  return typeof step.payload === "object" && step.payload !== null && !Array.isArray(step.payload);
}

/**
 * The remaining steps carried by a payload, or [] when there are none.
 *
 * Deliberately total rather than throwing: this reads a row that may have
 * been written by an older version of the app, and a payload whose chain
 * no longer parses must leave the job itself perfectly runnable — the
 * pipeline stops, the work this job was asked to do still happens.
 */
export function readChainSteps(payload: unknown): ChainStep[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as Record<string, unknown>)[CHAIN_PAYLOAD_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.every(isChainStep) ? (raw as ChainStep[]) : [];
}

/** Everything in a payload except the chain itself — what a handler sees as its own input. */
export function stripChain(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  const { [CHAIN_PAYLOAD_KEY]: _chain, ...rest } = payload as Record<string, unknown>;
  return rest;
}

export interface ChainedJobRequest {
  kind: JobKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * The job to enqueue now that `job` has succeeded, or null when the chain
 * is over (or was never there).
 *
 * The idempotency key is derived from the completed job's own id, which is
 * always server-generated and unique: a chain can therefore never be
 * duplicated — not by a double success, not by two workers, and not by a
 * payload a client tried to craft.
 */
export function nextChainedJob(job: Pick<Job, "id" | "payload">): ChainedJobRequest | null {
  const [next, ...rest] = readChainSteps(job.payload);
  if (!next) return null;
  return {
    kind: next.kind,
    payload: attachChain({ ...next.payload }, rest),
    idempotencyKey: `chain:${job.id}`,
  };
}
