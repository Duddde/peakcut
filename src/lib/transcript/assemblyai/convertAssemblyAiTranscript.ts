import type { Transcript, TranscriptWord } from "@/lib/domain/types";
import { clamp01, TranscriptInvalidPayloadError } from "../transcriptHttp";

/**
 * Converts a completed AssemblyAI transcript resource
 * (`GET /v2/transcript/:id` once `status === "completed"`, created with
 * `speaker_labels: true`) into PeakCut's Transcript/TranscriptWord shape.
 *
 * AssemblyAI reports all timings in milliseconds; every value is divided by
 * 1000 here so the rest of PeakCut only ever deals in seconds. Per-word
 * `confidence` is provided reliably by AssemblyAI, but a neutral 0.5 is
 * still used as an explicit fallback rather than assuming it's always
 * present.
 */

const DEFAULT_CONFIDENCE_WHEN_MISSING = 0.5;

type RawWord = Record<string, unknown>;

function extractRawWords(body: Record<string, unknown>): RawWord[] | null {
  if (Array.isArray(body.utterances)) {
    const flattened: RawWord[] = [];
    for (const rawUtterance of body.utterances) {
      if (typeof rawUtterance !== "object" || rawUtterance === null) continue;
      const utterance = rawUtterance as Record<string, unknown>;
      if (!Array.isArray(utterance.words)) continue;
      const utteranceSpeaker = typeof utterance.speaker === "string" ? utterance.speaker : undefined;
      for (const rawWord of utterance.words) {
        if (typeof rawWord !== "object" || rawWord === null) continue;
        const word = rawWord as RawWord;
        flattened.push(
          utteranceSpeaker && typeof word.speaker !== "string"
            ? { ...word, speaker: utteranceSpeaker }
            : word
        );
      }
    }
    if (flattened.length > 0) return flattened;
  }

  if (Array.isArray(body.words)) {
    return body.words as RawWord[];
  }

  return null;
}

export function convertAssemblyAiTranscript(payload: unknown, providerId: string): Transcript {
  if (typeof payload !== "object" || payload === null) {
    throw new TranscriptInvalidPayloadError(providerId, "le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  const rawWords = extractRawWords(body);
  if (!rawWords) {
    throw new TranscriptInvalidPayloadError(
      providerId,
      "aucun mot trouvé (champ 'utterances[].words' ou 'words' attendu)."
    );
  }

  const words: TranscriptWord[] = rawWords.map((w, index) => {
    const text = typeof w.text === "string" ? w.text : null;
    const startMs = typeof w.start === "number" ? w.start : null;
    const endMs = typeof w.end === "number" ? w.end : null;
    if (text === null || startMs === null || endMs === null) {
      throw new TranscriptInvalidPayloadError(
        providerId,
        `words[${index}] incomplet (texte/start/end requis).`
      );
    }

    const confidence =
      typeof w.confidence === "number" ? clamp01(w.confidence) : DEFAULT_CONFIDENCE_WHEN_MISSING;

    return {
      text,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
      speaker: typeof w.speaker === "string" ? w.speaker : undefined,
      confidence,
    };
  });

  return {
    language: typeof body.language_code === "string" ? body.language_code : "fr",
    providerId,
    words,
  };
}
