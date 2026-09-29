import type { Transcript } from "@/lib/domain/types";

export class TranscribeResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse de transcription invalide : ${message}`);
    this.name = "TranscribeResponseParseError";
  }
}

export interface ParsedTranscribeResult {
  providerId: string;
  transcript: Transcript;
}

/** Defensive client-side parser for the POST /api/transcribe JSON contract (snake_case). */
export function parseTranscribeResponse(payload: unknown): ParsedTranscribeResult {
  if (typeof payload !== "object" || payload === null) {
    throw new TranscribeResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (body.ok !== true) {
    throw new TranscribeResponseParseError("le champ ok doit valoir true.");
  }
  if (typeof body.provider_id !== "string") {
    throw new TranscribeResponseParseError("provider_id est manquant.");
  }

  const rawTranscript = body.transcript;
  if (typeof rawTranscript !== "object" || rawTranscript === null) {
    throw new TranscribeResponseParseError("le champ transcript est manquant.");
  }
  const t = rawTranscript as Record<string, unknown>;

  if (!Array.isArray(t.words)) {
    throw new TranscribeResponseParseError("transcript.words doit être un tableau.");
  }

  const words = t.words.map((rawWord, index) => {
    if (typeof rawWord !== "object" || rawWord === null) {
      throw new TranscribeResponseParseError(`transcript.words[${index}] invalide.`);
    }
    const w = rawWord as Record<string, unknown>;
    if (
      typeof w.text !== "string" ||
      typeof w.start_sec !== "number" ||
      typeof w.end_sec !== "number" ||
      typeof w.confidence !== "number"
    ) {
      throw new TranscribeResponseParseError(`transcript.words[${index}] : champs manquants.`);
    }
    return {
      text: w.text,
      startSec: w.start_sec,
      endSec: w.end_sec,
      speaker: typeof w.speaker === "string" ? w.speaker : undefined,
      confidence: w.confidence,
    };
  });

  return {
    providerId: body.provider_id,
    transcript: {
      language: typeof t.language === "string" ? t.language : "fr",
      providerId: body.provider_id,
      words,
    },
  };
}
