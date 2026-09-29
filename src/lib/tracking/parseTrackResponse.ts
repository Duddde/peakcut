import type { TrackingKeyframe } from "./types";

export class TrackResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse de tracking invalide : ${message}`);
    this.name = "TrackResponseParseError";
  }
}

export interface ParsedTrackResult {
  provider: string;
  track: {
    keyframes: TrackingKeyframe[];
    fallbackUsed: boolean;
    method: string;
  };
}

/** Defensive client-side parser for the POST /api/track JSON contract (snake_case). */
export function parseTrackResponse(payload: unknown): ParsedTrackResult {
  if (typeof payload !== "object" || payload === null) {
    throw new TrackResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (body.ok !== true) {
    throw new TrackResponseParseError("le champ ok doit valoir true.");
  }
  if (typeof body.provider !== "string") {
    throw new TrackResponseParseError("provider est manquant.");
  }

  const rawTrack = body.track;
  if (typeof rawTrack !== "object" || rawTrack === null) {
    throw new TrackResponseParseError("le champ track est manquant.");
  }
  const t = rawTrack as Record<string, unknown>;

  if (!Array.isArray(t.keyframes)) {
    throw new TrackResponseParseError("track.keyframes doit être un tableau.");
  }
  if (typeof t.fallback_used !== "boolean") {
    throw new TrackResponseParseError("track.fallback_used doit être un booléen.");
  }
  if (typeof t.method !== "string") {
    throw new TrackResponseParseError("track.method doit être une chaîne.");
  }

  const keyframes = t.keyframes.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TrackResponseParseError(`track.keyframes[${index}] invalide.`);
    }
    const k = raw as Record<string, unknown>;
    if (
      typeof k.t_sec !== "number" ||
      typeof k.cx !== "number" ||
      typeof k.cy !== "number" ||
      typeof k.confidence !== "number"
    ) {
      throw new TrackResponseParseError(`track.keyframes[${index}] : champs manquants.`);
    }
    return { tSec: k.t_sec, cx: k.cx, cy: k.cy, confidence: k.confidence };
  });

  return {
    provider: body.provider,
    track: { keyframes, fallbackUsed: t.fallback_used, method: t.method },
  };
}
