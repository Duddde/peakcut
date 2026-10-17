/**
 * Adapter interface for the backends that can generate an illustration
 * from a prompt.
 *
 * Shaped exactly like lib/transcript's TranscriptProvider, and for the
 * same reason: a provider only touches the network when it is actually
 * invoked, never at import time, and a provider without its API key
 * fails loudly instead of returning something invented. Nothing in
 * PeakCut ever fabricates an image.
 *
 * Generating sends the prompt — the user's own words — to the configured
 * provider. That is the one outbound transfer this feature performs, and
 * it happens only on an explicit request.
 */

export type ImageAspect = "portrait" | "square" | "landscape";

export const IMAGE_ASPECTS: ImageAspect[] = ["portrait", "square", "landscape"];

export interface ImageGenerationRequest {
  prompt: string;
  /** "portrait" is the useful default here: a short is vertical. */
  aspect: ImageAspect;
}

export interface GeneratedImage {
  data: Buffer;
  /** As reported by the provider; the asset store re-derives it from the bytes anyway. */
  mimeType: string;
  providerId: string;
  prompt: string;
}

export interface ImageProvider {
  readonly id: string;
  readonly displayName: string;
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}

export class ImageProviderNotConfiguredError extends Error {
  constructor(providerId: string, missing: string) {
    super(`Le fournisseur d'images "${providerId}" n'est pas configuré (${missing} manquant).`);
    this.name = "ImageProviderNotConfiguredError";
  }
}

export class ImageProviderHttpError extends Error {
  readonly status: number;
  constructor(providerId: string, status: number, statusText: string, bodySnippet: string) {
    super(
      `Le fournisseur d'images "${providerId}" a répondu avec une erreur HTTP ${status} ${statusText}` +
        (bodySnippet ? ` : ${bodySnippet}` : "")
    );
    this.name = "ImageProviderHttpError";
    this.status = status;
  }
}

export class ImageProviderInvalidPayloadError extends Error {
  constructor(providerId: string, reason: string) {
    super(`Réponse invalide du fournisseur d'images "${providerId}" : ${reason}`);
    this.name = "ImageProviderInvalidPayloadError";
  }
}

export class ImageProviderTimeoutError extends Error {
  constructor(providerId: string, timeoutMs: number) {
    super(`Le fournisseur d'images "${providerId}" a dépassé le délai d'attente (${timeoutMs}ms).`);
    this.name = "ImageProviderTimeoutError";
  }
}

/** Matches the global `fetch` signature so a test double can be injected without touching the network. */
export type FetchLike = typeof fetch;

export async function fetchImageWithTimeout(
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
      throw new ImageProviderTimeoutError(providerId, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function assertOkImageResponse(res: Response, providerId: string): Promise<void> {
  if (res.ok) return;
  let bodySnippet = "";
  try {
    bodySnippet = (await res.text()).slice(0, 500);
  } catch {
    bodySnippet = "";
  }
  throw new ImageProviderHttpError(providerId, res.status, res.statusText, bodySnippet);
}
