import type { NormalizedRect } from "@/lib/domain/types";

export class PreviewRequestParseError extends Error {
  constructor(message: string) {
    super(`Requête d'aperçu invalide : ${message}`);
    this.name = "PreviewRequestParseError";
  }
}

export interface PreviewRequestBody {
  sourcePath: string;
  startSec: number;
  endSec: number;
  crop?: NormalizedRect;
}

function parseCrop(raw: unknown): NormalizedRect | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new PreviewRequestParseError("crop doit être un objet.");
  }
  const c = raw as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof c[key] !== "number") {
      throw new PreviewRequestParseError(`crop.${key} doit être un nombre.`);
    }
  }
  return { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number };
}

/**
 * Deliberately narrower than parseExportRequestBody: no `words`, no
 * `workflow` — the free anonymous preview never burns in subtitles and
 * never checks export authorization (it isn't an export).
 */
export function parsePreviewRequestBody(payload: unknown): PreviewRequestBody {
  if (typeof payload !== "object" || payload === null) {
    throw new PreviewRequestParseError("le corps de la requête doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (typeof body.sourcePath !== "string" || body.sourcePath.trim().length === 0) {
    throw new PreviewRequestParseError("sourcePath est requis.");
  }
  if (body.sourcePath.includes("..")) {
    throw new PreviewRequestParseError("sourcePath ne doit pas contenir de séquence de parcours de chemin.");
  }
  if (typeof body.startSec !== "number" || typeof body.endSec !== "number") {
    throw new PreviewRequestParseError("startSec/endSec doivent être des nombres.");
  }
  if (!(body.endSec > body.startSec)) {
    throw new PreviewRequestParseError("endSec doit être strictement supérieur à startSec.");
  }

  return {
    sourcePath: body.sourcePath,
    startSec: body.startSec,
    endSec: body.endSec,
    crop: parseCrop(body.crop),
  };
}
