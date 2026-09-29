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
    throw err;
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
