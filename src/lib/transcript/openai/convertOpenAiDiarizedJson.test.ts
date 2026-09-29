import { describe, expect, it } from "vitest";
import { convertOpenAiDiarizedJson } from "./convertOpenAiDiarizedJson";
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

  it("defaults language to 'fr' when absent", () => {
    const transcript = convertOpenAiDiarizedJson(
      { words: [{ word: "x", start: 0, end: 0.1 }] },
      PROVIDER_ID
    );
    expect(transcript.language).toBe("fr");
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
