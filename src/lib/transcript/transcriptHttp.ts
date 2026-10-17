import { stat } from "node:fs/promises";

/**
 * Shared HTTP/error/file-validation plumbing for real transcript provider
 * adapters. Nothing here is provider-specific and nothing here performs a
 * network call on its own — it's the toolkit OpenAiTranscribeProvider and
 * AssemblyAiProvider are built from.
 */

/** Matches the global `fetch` signature so a test double can be injected without touching the network. */
export type FetchLike = typeof fetch;

export class TranscriptTimeoutError extends Error {
  constructor(providerId: string, timeoutMs: number) {
    super(`Le fournisseur "${providerId}" a dépassé le délai d'attente (${timeoutMs}ms).`);
    this.name = "TranscriptTimeoutError";
  }
}

export class TranscriptHttpError extends Error {
  readonly status: number;
  constructor(providerId: string, status: number, statusText: string, bodySnippet: string) {
    super(
      `Le fournisseur "${providerId}" a répondu avec une erreur HTTP ${status} ${statusText}${
        bodySnippet ? ` : ${bodySnippet}` : ""
      }`
    );
    this.name = "TranscriptHttpError";
    this.status = status;
  }
}

export class TranscriptInvalidPayloadError extends Error {
  constructor(providerId: string, reason: string) {
    super(`Réponse invalide du fournisseur "${providerId}" : ${reason}`);
    this.name = "TranscriptInvalidPayloadError";
  }
}

export class LocalMediaFileNotFoundError extends Error {
  constructor(mediaPath: string) {
    super(`Fichier média local introuvable : "${mediaPath}".`);
    this.name = "LocalMediaFileNotFoundError";
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * The media is still over the provider's upload limit after its audio
 * track was extracted — i.e. it is simply too long. Splitting a long
 * recording into several requests is not implemented, so this fails
 * explicitly rather than sending a truncated file and returning a
 * transcript that silently stops halfway.
 */
export class TranscriptMediaTooLargeError extends Error {
  constructor(providerId: string, sizeBytes: number, limitBytes: number) {
    super(
      `L'audio extrait pèse ${megabytes(sizeBytes)}, au-delà de la limite de ${megabytes(limitBytes)} du fournisseur "${providerId}". ` +
        "Transcrivez un extrait plus court."
    );
    this.name = "TranscriptMediaTooLargeError";
  }
}

/** Throws LocalMediaFileNotFoundError if mediaPath does not resolve to a real, readable file. */
export async function assertLocalFileExists(mediaPath: string): Promise<void> {
  try {
    const info = await stat(mediaPath);
    if (!info.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new LocalMediaFileNotFoundError(mediaPath);
  }
}

/**
 * Node's fetch reports every transport failure as a bare
 * "TypeError: fetch failed" and hides the real reason in `cause`. A
 * provider dying on `UND_ERR_HEADERS_TIMEOUT` was therefore
 * indistinguishable, in the job's recorded error, from DNS failing or the
 * connection being refused — three identical messages, three different
 * things to do about it. The cause is folded into the message here.
 */
function withNetworkCause(err: unknown, providerId: string): unknown {
  if (!(err instanceof Error) || err.message !== "fetch failed") return err;
  const cause = err.cause;
  const detail =
    cause instanceof Error
      ? `${(cause as NodeJS.ErrnoException).code ?? cause.name} — ${cause.message}`
      : typeof cause === "string"
        ? cause
        : null;
  if (!detail) return err;
  const wrapped = new Error(`Appel au fournisseur "${providerId}" impossible : ${detail}`);
  wrapped.name = err.name;
  wrapped.cause = cause;
  return wrapped;
}

/**
 * Wraps a fetch call with an AbortController-based timeout. Network errors
 * pass through unchanged; an aborted request becomes a TranscriptTimeoutError.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  providerId: string,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TranscriptTimeoutError(providerId, timeoutMs);
    }
    throw withNetworkCause(err, providerId);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws TranscriptHttpError for a non-2xx response; otherwise resolves to undefined. */
export async function assertOkResponse(res: Response, providerId: string): Promise<void> {
  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 500);
    } catch {
      bodySnippet = "";
    }
    throw new TranscriptHttpError(providerId, res.status, res.statusText, bodySnippet);
  }
}

/** Parses a Response as JSON, converting any parse failure into a typed TranscriptInvalidPayloadError. */
export async function parseJsonResponse(res: Response, providerId: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new TranscriptInvalidPayloadError(providerId, "le corps de la réponse n'est pas un JSON valide.");
  }
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
