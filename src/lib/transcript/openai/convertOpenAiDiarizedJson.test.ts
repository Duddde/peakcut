import { describe, expect, it } from "vitest";
import { convertOpenAiDiarizedJson, hasInterpolatedWordTimings } from "./convertOpenAiDiarizedJson";
import { TranscriptInvalidPayloadError } from "../transcriptHttp";

const PROVIDER_ID = "openai-gpt-4o-transcribe-diarize";

describe("convertOpenAiDiarizedJson", () => {
  it("converts a top-level words[] payload with diarization and confidence", () => {
    const transcript = convertOpenAiDiarizedJson(
      {
        language: "fr",
        words: [
          { word: "Bonjour", start: 0, end: 0.4, speaker: "A", confidence: 0.92 },
          { word: "tout", start: 0.45, end: 0.6, speaker: "A", confidence: 0.88 },
          { word: "le", start: 0.62, end: 0.7, speaker: "A", confidence: 0.9 },
          { word: "monde", start: 0.75, end: 1.1, speaker: "B", confidence: 0.95 },
        ],
      },
      PROVIDER_ID
    );

    expect(transcript.providerId).toBe(PROVIDER_ID);
    expect(transcript.language).toBe("fr");
    expect(transcript.words).toHaveLength(4);
    expect(transcript.words[0]).toEqual({
      text: "Bonjour",
      startSec: 0,
      endSec: 0.4,
      speaker: "A",
      confidence: 0.92,
    });
    expect(transcript.words[3].speaker).toBe("B");
  });

  it("flattens segments[].words[] and inherits the segment speaker when a word has none", () => {
    const transcript = convertOpenAiDiarizedJson(
      {
        segments: [
          {
            speaker: "A",
            words: [
              { word: "Salut", start: 0, end: 0.3 },
              { word: "toi", start: 0.35, end: 0.5, speaker: "B" },
            ],
          },
        ],
      },
      PROVIDER_ID
    );

    expect(transcript.words[0].speaker).toBe("A");
    expect(transcript.words[1].speaker).toBe("B");
  });

  it("accepts 'text' as an alternative to 'word' for the token field", () => {
    const transcript = convertOpenAiDiarizedJson(
      { words: [{ text: "Ok", start: 0, end: 0.2 }] },
      PROVIDER_ID
    );
    expect(transcript.words[0].text).toBe("Ok");
  });

  it("marks the language undetermined when the provider reports none", () => {
    const transcript = convertOpenAiDiarizedJson(
      { words: [{ word: "x", start: 0, end: 0.1 }] },
      PROVIDER_ID
    );
    expect(transcript.language).toBe("und");
  });

  it("uses a neutral 0.5 confidence when the API does not provide one, rather than inventing certainty", () => {
    const transcript = convertOpenAiDiarizedJson(
      { words: [{ word: "x", start: 0, end: 0.1 }] },
      PROVIDER_ID
    );
    expect(transcript.words[0].confidence).toBe(0.5);
  });

  it("clamps an out-of-range confidence into [0, 1]", () => {
    const transcript = convertOpenAiDiarizedJson(
      { words: [{ word: "x", start: 0, end: 0.1, confidence: 1.5 }] },
      PROVIDER_ID
    );
    expect(transcript.words[0].confidence).toBe(1);
  });

  it("throws TranscriptInvalidPayloadError when neither words nor segments is present", () => {
    expect(() => convertOpenAiDiarizedJson({ text: "just a transcript" }, PROVIDER_ID)).toThrow(
      TranscriptInvalidPayloadError
    );
  });

  it("throws TranscriptInvalidPayloadError when a word is missing start/end", () => {
    expect(() =>
      convertOpenAiDiarizedJson({ words: [{ word: "x" }] }, PROVIDER_ID)
    ).toThrow(TranscriptInvalidPayloadError);
  });

  it("throws TranscriptInvalidPayloadError for a non-object payload", () => {
    expect(() => convertOpenAiDiarizedJson(null, PROVIDER_ID)).toThrow(TranscriptInvalidPayloadError);
    expect(() => convertOpenAiDiarizedJson("oops", PROVIDER_ID)).toThrow(TranscriptInvalidPayloadError);
  });

  it("throws when segments contain no words at all", () => {
    expect(() =>
      convertOpenAiDiarizedJson({ segments: [{ speaker: "A", words: [] }] }, PROVIDER_ID)
    ).toThrow(TranscriptInvalidPayloadError);
  });
});

describe("convertOpenAiDiarizedJson — segments diarisés sans mots", () => {
  /**
   * The shape gpt-4o-transcribe-diarize actually returns, captured from a
   * real call: segments carrying text/speaker/start/end, and no word-level
   * timings anywhere (timestamp_granularities is not available for this
   * model). PeakCut is word-by-word, so the segment is split.
   */
  const REAL_SHAPE = {
    text: "Relentlessly. Turn the AH-64 Apache",
    task: "transcribe",
    duration: 3,
    segments: [
      { type: "transcript.text.segment", id: "seg_1", speaker: "A", start: 0, end: 2.55, text: "Relentlessly. Turn the AH-64 Apache" },
    ],
    usage: { type: "duration", seconds: 3 },
  };

  it("splits a diarized segment into words that span exactly its window", () => {
    const transcript = convertOpenAiDiarizedJson(REAL_SHAPE, "openai-gpt-4o-transcribe-diarize", "en");

    expect(transcript.words.map((w) => w.text)).toEqual([
      "Relentlessly.",
      "Turn",
      "the",
      "AH-64",
      "Apache",
    ]);
    expect(transcript.words[0].startSec).toBe(0);
    // The last word closes on the segment's real end, never past it.
    expect(transcript.words[transcript.words.length - 1].endSec).toBe(2.55);
  });

  it("keeps the words contiguous and ordered", () => {
    const { words } = convertOpenAiDiarizedJson(REAL_SHAPE, "openai-gpt-4o-transcribe-diarize");

    for (let i = 0; i < words.length; i++) {
      expect(words[i].endSec).toBeGreaterThan(words[i].startSec);
      if (i > 0) expect(words[i].startSec).toBe(words[i - 1].endSec);
    }
  });

  it("gives longer words a longer share of the segment", () => {
    const { words } = convertOpenAiDiarizedJson(REAL_SHAPE, "openai-gpt-4o-transcribe-diarize");
    const duration = (w: { startSec: number; endSec: number }) => w.endSec - w.startSec;

    expect(duration(words[0])).toBeGreaterThan(duration(words[2])); // "Relentlessly." vs "the"
  });

  it("carries the segment's speaker onto every word", () => {
    const { words } = convertOpenAiDiarizedJson(REAL_SHAPE, "openai-gpt-4o-transcribe-diarize");
    expect(words.every((w) => w.speaker === "A")).toBe(true);
  });

  it("uses the neutral confidence, since none of this was measured", () => {
    const { words } = convertOpenAiDiarizedJson(REAL_SHAPE, "openai-gpt-4o-transcribe-diarize");
    expect(words.every((w) => w.confidence === 0.5)).toBe(true);
  });

  it("falls back to the request's language hint when the provider reports none", () => {
    expect(convertOpenAiDiarizedJson(REAL_SHAPE, "p", "en").language).toBe("en");
    expect(convertOpenAiDiarizedJson(REAL_SHAPE, "p").language).toBe("und");
  });

  it("skips a segment with no usable text or window instead of inventing one", () => {
    const payload = {
      segments: [
        { speaker: "A", start: 0, end: 1, text: "   " },
        { speaker: "A", start: 2, end: 2, text: "déjà fini" },
        { speaker: "B", start: 3, end: 4, text: "gardé" },
      ],
    };
    const { words } = convertOpenAiDiarizedJson(payload, "p");
    expect(words.map((w) => w.text)).toEqual(["gardé"]);
  });

  it("names the keys it received when the shape is unusable", () => {
    expect(() => convertOpenAiDiarizedJson({ text: "x", usage: {} }, "p")).toThrowError(
      /Clés reçues : text:string, usage:object/
    );
  });

  it("flags this provider's word timings as interpolated", () => {
    expect(hasInterpolatedWordTimings("openai-gpt-4o-transcribe-diarize")).toBe(true);
    expect(hasInterpolatedWordTimings("assemblyai")).toBe(false);
  });
});
