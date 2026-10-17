import { IMAGE_ASPECTS, type ImageAspect } from "./ImageProvider";

/**
 * Validates a generation request before any of it leaves the machine.
 *
 * The prompt is the user's own text and is sent, as given, to the
 * configured provider — so it is bounded here (a prompt is not a payload)
 * and stripped of control characters, which no image model needs and
 * which make a stored prompt unreadable when it is shown back later.
 */

export class GenerateImageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateImageRequestError";
  }
}

export const MAX_PROMPT_LENGTH = 1000;
export const MIN_PROMPT_LENGTH = 3;

export interface GenerateImageRequest {
  prompt: string;
  aspect: ImageAspect;
  /** Absent means "the default provider"; resolved by the caller, not here. */
  providerId?: string;
}

export function parseGenerateImageRequest(payload: unknown): GenerateImageRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new GenerateImageRequestError("Le corps de la requête doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (typeof body.prompt !== "string") {
    throw new GenerateImageRequestError("prompt est requis.");
  }
  const prompt = body.prompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (prompt.length < MIN_PROMPT_LENGTH) {
    throw new GenerateImageRequestError(`prompt doit contenir au moins ${MIN_PROMPT_LENGTH} caractères.`);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new GenerateImageRequestError(`prompt dépasse ${MAX_PROMPT_LENGTH} caractères.`);
  }

  const aspect = body.aspect ?? "portrait";
  if (typeof aspect !== "string" || !IMAGE_ASPECTS.includes(aspect as ImageAspect)) {
    throw new GenerateImageRequestError(`aspect doit être l'un de : ${IMAGE_ASPECTS.join(", ")}.`);
  }

  if (body.providerId !== undefined && typeof body.providerId !== "string") {
    throw new GenerateImageRequestError("providerId doit être une chaîne.");
  }

  return { prompt, aspect: aspect as ImageAspect, providerId: body.providerId as string | undefined };
}
