/**
 * Pure validation of a user-supplied media upload's metadata: size, MIME
 * type, and filename. This never touches the network and never triggers a
 * YouTube (or any other) download — it only validates bytes the user
 * already provided directly to this machine.
 */

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB, enough for a short local demo clip.
export const MIN_UPLOAD_BYTES = 1;

/** extension (without dot) -> allowed MIME types for that extension. Cross-checked both ways to resist spoofing. */
const ALLOWED_EXTENSION_MIME_TYPES: Record<string, readonly string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  webm: ["video/webm"],
  mkv: ["video/x-matroska"],
  mp3: ["audio/mpeg"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  m4a: ["audio/mp4", "audio/x-m4a"],
};

const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,180}$/;
const MAX_FILENAME_LENGTH = 200;

export interface UploadMetadata {
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

export type UploadValidationResult = { ok: true } | { ok: false; error: string };

function extensionOf(filename: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : null;
}

export function validateUploadMetadata(meta: UploadMetadata): UploadValidationResult {
  const filename = meta.filename?.trim() ?? "";

  if (!filename) {
    return { ok: false, error: "Le nom de fichier est requis." };
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return { ok: false, error: "Le nom de fichier est trop long." };
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return { ok: false, error: "Le nom de fichier contient des caractères de chemin interdits." };
  }
  if (!SAFE_FILENAME_PATTERN.test(filename)) {
    return {
      ok: false,
      error: "Le nom de fichier contient des caractères non autorisés.",
    };
  }

  const extension = extensionOf(filename);
  if (!extension || !(extension in ALLOWED_EXTENSION_MIME_TYPES)) {
    return {
      ok: false,
      error: `Extension non autorisée. Formats acceptés : ${Object.keys(ALLOWED_EXTENSION_MIME_TYPES).join(", ")}.`,
    };
  }

  const allowedMimeTypes = ALLOWED_EXTENSION_MIME_TYPES[extension];
  if (!allowedMimeTypes.includes(meta.mimeType)) {
    return {
      ok: false,
      error: `Le type MIME "${meta.mimeType}" ne correspond pas à l'extension .${extension}.`,
    };
  }

  if (!Number.isFinite(meta.sizeBytes) || meta.sizeBytes < MIN_UPLOAD_BYTES) {
    return { ok: false, error: "Le fichier est vide ou sa taille est invalide." };
  }
  if (meta.sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Le fichier dépasse la taille maximale autorisée (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} Mo).`,
    };
  }

  return { ok: true };
}
