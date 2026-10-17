import {
  ImageProviderInvalidPayloadError,
  ImageProviderNotConfiguredError,
  assertOkImageResponse,
  fetchImageWithTimeout,
  type FetchLike,
  type GeneratedImage,
  type ImageAspect,
  type ImageGenerationRequest,
  type ImageProvider,
} from "./ImageProvider";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-1";

/** Generating an image is tens of seconds of work on the provider's side. */
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

/** The sizes the model accepts, mapped from what a short actually needs. */
const SIZE_BY_ASPECT: Record<ImageAspect, string> = {
  portrait: "1024x1536",
  square: "1024x1024",
  landscape: "1536x1024",
};

function configuredTimeoutMs(): number {
  const raw = Number(process.env.PEAKCUT_IMAGE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface OpenAiImageProviderDeps {
  /** Injectable fetch, used by tests to avoid any real network access. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Real adapter for OpenAI's image generation endpoint (gpt-image-1).
 *
 * The API key is read from the environment at call time, placed only in
 * the Authorization header of the single outgoing request, and never
 * logged. Without it this throws immediately and nothing is sent.
 *
 * The response is base64 image bytes. They are decoded and handed back
 * raw: this adapter deliberately does not decide whether they are a
 * usable image — the asset store sniffs the bytes itself before anything
 * is written, so a provider returning something unexpected is caught by
 * the same check that guards an upload.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly id = "openai-gpt-image-1";
  readonly displayName = "OpenAI gpt-image-1";

  constructor(private readonly deps: OpenAiImageProviderDeps = {}) {}

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ImageProviderNotConfiguredError(this.id, "OPENAI_API_KEY");
    }

    const timeoutMs = this.deps.timeoutMs ?? configuredTimeoutMs();
    const res = await fetchImageWithTimeout(
      this.deps.fetchImpl ?? fetch,
      this.id,
      OPENAI_IMAGES_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt: request.prompt,
          size: SIZE_BY_ASPECT[request.aspect],
          n: 1,
          output_format: "png",
        }),
      },
      timeoutMs
    );

    await assertOkImageResponse(res, this.id);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ImageProviderInvalidPayloadError(this.id, "le corps de la réponse n'est pas un JSON valide.");
    }

    const base64 = firstBase64Image(json);
    if (!base64) {
      throw new ImageProviderInvalidPayloadError(this.id, "aucune image (data[0].b64_json) dans la réponse.");
    }

    const data = Buffer.from(base64, "base64");
    if (data.length === 0) {
      throw new ImageProviderInvalidPayloadError(this.id, "l'image renvoyée est vide.");
    }

    return { data, mimeType: "image/png", providerId: this.id, prompt: request.prompt };
  }
}

function firstBase64Image(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first !== "object" || first === null) return null;
  const b64 = (first as { b64_json?: unknown }).b64_json;
  return typeof b64 === "string" && b64.length > 0 ? b64 : null;
}
