/**
 * What PeakCut accepts as an illustration, and how it decides.
 *
 * These bytes end up as an input to the real ffmpeg render, so the
 * declared MIME type is not trusted: a caller can write anything in a
 * multipart header. The file's own signature is read instead, and an
 * upload whose signature contradicts its declared type is refused rather
 * than renamed — a mismatch is either a broken client or an attempt, and
 * neither should reach the renderer.
 */

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** Canonical extension per accepted type; also the only extensions ever written to disk. */
export const IMAGE_EXTENSIONS: Record<ImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export const IMAGE_MIME_TYPES = Object.keys(IMAGE_EXTENSIONS) as ImageMimeType[];

/** 12 MB: far more than an illustration needs, far less than a video. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;
export const MIN_ASSET_BYTES = 64;

export const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Project ids are uuids in production; tests and fixtures use short slugs. Either way, no path separator ever. */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAssetId(value: string): boolean {
  return ASSET_ID_PATTERN.test(value);
}

export function isValidProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

export function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as string[]).includes(value);
}

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => data[offset + i] === byte);
}

/**
 * The type the bytes actually are, from their signature alone, or null
 * when they are none of the three PeakCut accepts.
 */
export function sniffImageMimeType(data: Uint8Array): ImageMimeType | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export type ImageAssetValidation = { ok: true; mimeType: ImageMimeType } | { ok: false; error: string };

export interface ValidateImageAssetInput {
  /** As declared by the caller (an upload's content type). Optional: a generated image declares nothing. */
  declaredMimeType?: string;
  data: Uint8Array;
}

export function validateImageAsset(input: ValidateImageAssetInput): ImageAssetValidation {
  const { data, declaredMimeType } = input;

  if (data.length < MIN_ASSET_BYTES) {
    return { ok: false, error: "Le fichier est vide ou trop petit pour être une image." };
  }
  if (data.length > MAX_ASSET_BYTES) {
    return {
      ok: false,
      error: `L'image dépasse la taille maximale autorisée (${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} Mo).`,
    };
  }

  const sniffed = sniffImageMimeType(data);
  if (!sniffed) {
    return {
      ok: false,
      error: `Format d'image non reconnu. Formats acceptés : ${IMAGE_MIME_TYPES.join(", ")}.`,
    };
  }

  if (declaredMimeType && declaredMimeType !== sniffed) {
    return {
      ok: false,
      error: `Le type déclaré ("${declaredMimeType}") ne correspond pas au contenu réel du fichier ("${sniffed}").`,
    };
  }

  return { ok: true, mimeType: sniffed };
}
