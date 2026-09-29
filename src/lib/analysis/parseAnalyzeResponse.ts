import type { Segment, ScoreBreakdown } from "@/lib/domain/types";

/**
 * Defensive parser for the /api/analyze JSON contract (snake_case) into the
 * internal Segment shape (camelCase) the studio UI renders. This is a
 * boundary function: the payload came over the network (even if it's our
 * own same-origin API), so every field is checked before use rather than
 * blindly cast.
 */

export class AnalyzeResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse d'analyse invalide : ${message}`);
    this.name = "AnalyzeResponseParseError";
  }
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AnalyzeResponseParseError(`le champ "${field}" doit être un tableau.`);
  }
  return value;
}

function parseBreakdown(raw: unknown): ScoreBreakdown {
  if (typeof raw !== "object" || raw === null) {
    throw new AnalyzeResponseParseError("score_breakdown manquant ou invalide.");
  }
  const b = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const v = b[key];
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new AnalyzeResponseParseError(`score_breakdown.${key} doit être un nombre.`);
    }
    return v;
  };
  return {
    hook: num("hook"),
    lexicalDensity: num("lexical_density"),
    question: num("question"),
    emotion: num("emotion"),
    speakerChange: num("speaker_change"),
    duration: num("duration"),
    penalties: num("penalties"),
  };
}

export interface ParsedRankedSegment extends Segment {
  rank: number;
  categories: string[];
}

export function parseAnalyzeResponse(payload: unknown): ParsedRankedSegment[] {
  if (typeof payload !== "object" || payload === null) {
    throw new AnalyzeResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) {
    throw new AnalyzeResponseParseError("le champ ok doit valoir true.");
  }

  const rawSegments = requireArray(body.segments, "segments");

  return rawSegments.map((rawSegment, index): ParsedRankedSegment => {
    if (typeof rawSegment !== "object" || rawSegment === null) {
      throw new AnalyzeResponseParseError(`segments[${index}] doit être un objet.`);
    }
    const s = rawSegment as Record<string, unknown>;

    const id = s.id;
    const title = s.title;
    if (typeof id !== "string" || typeof title !== "string") {
      throw new AnalyzeResponseParseError(`segments[${index}] : id/title manquants.`);
    }

    const words = requireArray(s.words, `segments[${index}].words`).map((rawWord, wIndex) => {
      if (typeof rawWord !== "object" || rawWord === null) {
        throw new AnalyzeResponseParseError(`segments[${index}].words[${wIndex}] invalide.`);
      }
      const w = rawWord as Record<string, unknown>;
      if (
        typeof w.text !== "string" ||
        typeof w.start_sec !== "number" ||
        typeof w.end_sec !== "number" ||
        typeof w.confidence !== "number"
      ) {
        throw new AnalyzeResponseParseError(`segments[${index}].words[${wIndex}] : champs manquants.`);
      }
      return {
        text: w.text,
        startSec: w.start_sec,
        endSec: w.end_sec,
        speaker: typeof w.speaker === "string" ? w.speaker : undefined,
        confidence: w.confidence,
      };
    });

    const safeZones = requireArray(s.safe_zones, `segments[${index}].safe_zones`).map((rawZone) => {
      const z = rawZone as Record<string, unknown>;
      return {
        id: String(z.id),
        purpose: z.purpose as Segment["safeZones"][number]["purpose"],
        label: String(z.label),
        rect: z.rect as Segment["safeZones"][number]["rect"],
      };
    });

    const variants = requireArray(s.variants, `segments[${index}].variants`).map((rawVariant) => {
      const v = rawVariant as Record<string, unknown>;
      return {
        id: String(v.id),
        label: String(v.label),
        aspectRatio: v.aspect_ratio as Segment["variants"][number]["aspectRatio"],
        crop: v.crop as Segment["variants"][number]["crop"],
      };
    });

    if (typeof s.start_sec !== "number" || typeof s.end_sec !== "number") {
      throw new AnalyzeResponseParseError(`segments[${index}] : start_sec/end_sec manquants.`);
    }

    return {
      id,
      projectId: "analyzed-project",
      title,
      startSec: s.start_sec,
      endSec: s.end_sec,
      words,
      safeZones,
      variants,
      score:
        s.score_breakdown && typeof s.score === "number" && typeof s.confidence === "number"
          ? {
              value: s.score,
              confidence: s.confidence,
              explanation: {
                breakdown: parseBreakdown(s.score_breakdown),
                reasons: requireArray(s.reasons, `segments[${index}].reasons`).map(String),
                penaltyReasons: requireArray(s.penalty_reasons, `segments[${index}].penalty_reasons`).map(
                  String
                ),
              },
            }
          : null,
      rank: typeof s.rank === "number" ? s.rank : index + 1,
      categories: requireArray(s.categories, `segments[${index}].categories`).map(String),
    };
  });
}
