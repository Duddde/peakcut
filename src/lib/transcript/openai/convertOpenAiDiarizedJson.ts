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
      const segmentSpeaker = typeof segment.speaker === "string" ? segment.speaker : undefined;

      if (Array.isArray(segment.words)) {
        for (const rawWord of segment.words) {
          if (typeof rawWord !== "object" || rawWord === null) continue;
          const word = rawWord as RawWord;
          flattened.push(
            segmentSpeaker && typeof word.speaker !== "string" ? { ...word, speaker: segmentSpeaker } : word
          );
        }
        continue;
      }

      flattened.push(...splitSegmentIntoWords(segment, segmentSpeaker));
    }
    return flattened.length > 0 ? flattened : null;
  }

  return null;
}

/**
 * Spreads one diarized segment's text across its [start, end] window,
 * proportionally to each word's length.
 *
 * This is what the model actually returns: `gpt-4o-transcribe-diarize`
 * has no word-level timestamps and `timestamp_granularities` is not
 * available for it, so a segment is the finest timing OpenAI gives. The
 * rest of PeakCut is word-by-word (the burned-in ASS subtitles light up
 * word by word), hence this split.
 *
 * The resulting per-word boundaries are therefore INTERPOLATED, not
 * measured: the segment's own start and end are real, what happens
 * between them is an estimate. Each word carries the neutral
 * DEFAULT_CONFIDENCE_WHEN_MISSING for that reason, and
 * `hasInterpolatedWordTimings` lets the UI say so.
 */
function splitSegmentIntoWords(segment: Record<string, unknown>, speaker: string | undefined): RawWord[] {
  const text = typeof segment.text === "string" ? segment.text.trim() : "";
  const start = typeof segment.start === "number" ? segment.start : null;
  const end = typeof segment.end === "number" ? segment.end : null;
  if (text.length === 0 || start === null || end === null || !(end > start)) return [];

  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  const totalChars = tokens.reduce((sum, token) => sum + token.length, 0);
  const span = end - start;

  let cursor = start;
  return tokens.map((token, index) => {
    const share = (token.length / totalChars) * span;
    const wordStart = cursor;
    // The last word closes exactly on the segment's real end, so rounding
    // can never push a word past the boundary the model reported.
    const wordEnd = index === tokens.length - 1 ? end : Math.min(end, wordStart + share);
    cursor = wordEnd;
    return { word: token, start: wordStart, end: wordEnd, speaker };
  });
}

/** Providers whose per-word timings are interpolated from coarser segments (see splitSegmentIntoWords). */
export function hasInterpolatedWordTimings(providerId: string): boolean {
  return providerId === "openai-gpt-4o-transcribe-diarize";
}

/**
 * A one-line description of a payload's structure: top-level keys, and
 * for the first element of any array, its own keys. Never includes a
 * value, so a transcript's text can't leak into an error message or a log.
 */
function describeShape(body: Record<string, unknown>): string {
  return (
    Object.entries(body)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          const first = value[0];
          const inner =
            typeof first === "object" && first !== null
              ? `[{${Object.keys(first as Record<string, unknown>).join(",")}}]`
              : "[]";
          return `${key}:${value.length}${inner}`;
        }
        return `${key}:${typeof value}`;
      })
      .join(", ") || "(objet vide)"
  );
}

/**
 * BCP-47 "undetermined". Used when the provider reports no language:
 * `gpt-4o-transcribe-diarize` returns none at all, and defaulting to "fr"
 * labelled every English transcript as French.
 */
const UNDETERMINED_LANGUAGE = "und";

export function convertOpenAiDiarizedJson(
  payload: unknown,
  providerId: string,
  languageHint?: string
): Transcript {
  if (typeof payload !== "object" || payload === null) {
    throw new TranscriptInvalidPayloadError(providerId, "le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  const rawWords = extractRawWords(body);
  if (!rawWords) {
    // Naming the keys actually received turns "the shape changed" into a
    // one-line diagnosis. Keys only — never the transcript's content.
    throw new TranscriptInvalidPayloadError(
      providerId,
      `aucun mot trouvé (champ 'words' ou 'segments[].words' attendu). Clés reçues : ${describeShape(body)}.`
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
    language: typeof body.language === "string" ? body.language : languageHint ?? UNDETERMINED_LANGUAGE,
    providerId,
    words,
  };
}
