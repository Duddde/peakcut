import type { Transcript, TranscriptWord } from "@/lib/domain/types";
import { clamp01, TranscriptInvalidPayloadError } from "../transcriptHttp";

/**
 * Converts OpenAI's audio transcription response (model
 * `gpt-4o-transcribe-diarize`, `response_format: "diarized_json"`) into
 * PeakCut's Transcript/TranscriptWord shape.
 *
 * ASSUMPTION, documented explicitly: this preview response format is not
 * fully stable/public at the time of writing. This parser accepts either a
 * top-level `words: [{ word|text, start, end, speaker?, confidence? }]`
 * array, or a `segments: [{ speaker?, words: [...] }]` array whose words
 * inherit the segment's speaker when the word itself has none. If OpenAI's
 * actual field names differ, this is the single place to adjust — every
 * other part of PeakCut only ever sees the resulting Transcript. When the
 * response provides no per-word confidence, a neutral 0.5 is used rather
 * than inventing a falsely precise number.
 */

const DEFAULT_CONFIDENCE_WHEN_MISSING = 0.5;

type RawWord = Record<string, unknown>;

function extractRawWords(body: Record<string, unknown>): RawWord[] | null {
  if (Array.isArray(body.words)) {
    return body.words as RawWord[];
  }

  if (Array.isArray(body.segments)) {
    const flattened: RawWord[] = [];
    for (const rawSegment of body.segments) {
      if (typeof rawSegment !== "object" || rawSegment === null) continue;
      const segment = rawSegment as Record<string, unknown>;
      if (!Array.isArray(segment.words)) continue;
      const segmentSpeaker = typeof segment.speaker === "string" ? segment.speaker : undefined;
      for (const rawWord of segment.words) {
        if (typeof rawWord !== "object" || rawWord === null) continue;
        const word = rawWord as RawWord;
        flattened.push(
          segmentSpeaker && typeof word.speaker !== "string" ? { ...word, speaker: segmentSpeaker } : word
        );
      }
    }
    return flattened.length > 0 ? flattened : null;
  }

  return null;
}

export function convertOpenAiDiarizedJson(payload: unknown, providerId: string): Transcript {
  if (typeof payload !== "object" || payload === null) {
    throw new TranscriptInvalidPayloadError(providerId, "le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  const rawWords = extractRawWords(body);
  if (!rawWords) {
    throw new TranscriptInvalidPayloadError(
      providerId,
      "aucun mot trouvé (champ 'words' ou 'segments[].words' attendu)."
    );
  }

  const words: TranscriptWord[] = rawWords.map((w, index) => {
    const text = typeof w.word === "string" ? w.word : typeof w.text === "string" ? w.text : null;
    const startSec = typeof w.start === "number" ? w.start : null;
    const endSec = typeof w.end === "number" ? w.end : null;
    if (text === null || startSec === null || endSec === null) {
      throw new TranscriptInvalidPayloadError(
        providerId,
        `words[${index}] incomplet (texte/start/end requis).`
      );
    }

    const confidence =
      typeof w.confidence === "number" ? clamp01(w.confidence) : DEFAULT_CONFIDENCE_WHEN_MISSING;

    return {
      text,
      startSec,
      endSec,
      speaker: typeof w.speaker === "string" ? w.speaker : undefined,
      confidence,
    };
  });

  return {
    language: typeof body.language === "string" ? body.language : "fr",
    providerId,
    words,
  };
}
