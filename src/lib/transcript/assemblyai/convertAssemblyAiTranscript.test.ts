import { describe, expect, it } from "vitest";
import { convertAssemblyAiTranscript } from "./convertAssemblyAiTranscript";
import { TranscriptInvalidPayloadError } from "../transcriptHttp";

const PROVIDER_ID = "assemblyai";

describe("convertAssemblyAiTranscript", () => {
  it("converts utterances[].words[] (millisecond timings) into second-based TranscriptWords", () => {
    const transcript = convertAssemblyAiTranscript(
      {
        status: "completed",
        language_code: "fr",
        utterances: [
          {
            speaker: "A",
            start: 0,
            end: 1200,
            text: "Bonjour tout le monde",
            words: [
              { text: "Bonjour", start: 0, end: 400, confidence: 0.95 },
              { text: "tout", start: 450, end: 600, confidence: 0.9 },
              { text: "le", start: 620, end: 700, confidence: 0.93 },
              { text: "monde", start: 750, end: 1100, confidence: 0.97 },
            ],
          },
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
      confidence: 0.95,
    });
  });

  it("uses the word's own speaker when present, even inside an utterance", () => {
    const transcript = convertAssemblyAiTranscript(
      {
        status: "completed",
        utterances: [
          {
            speaker: "A",
            start: 0,
            end: 1000,
            words: [
              { text: "Salut", start: 0, end: 300, confidence: 0.9 },
              { text: "toi", start: 350, end: 500, confidence: 0.9, speaker: "B" },
            ],
          },
        ],
      },
      PROVIDER_ID
    );
    expect(transcript.words[0].speaker).toBe("A");
    expect(transcript.words[1].speaker).toBe("B");
  });

  it("falls back to top-level words[] when there are no utterances", () => {
    const transcript = convertAssemblyAiTranscript(
      {
        status: "completed",
        words: [{ text: "Ok", start: 0, end: 200, confidence: 0.8, speaker: "A" }],
      },
      PROVIDER_ID
    );
    expect(transcript.words).toHaveLength(1);
    expect(transcript.words[0].startSec).toBe(0);
    expect(transcript.words[0].endSec).toBe(0.2);
  });

  it("defaults language to 'fr' when language_code is absent", () => {
    const transcript = convertAssemblyAiTranscript(
      { status: "completed", words: [{ text: "x", start: 0, end: 100 }] },
      PROVIDER_ID
    );
    expect(transcript.language).toBe("fr");
  });

  it("uses a neutral 0.5 confidence when missing, rather than inventing certainty", () => {
    const transcript = convertAssemblyAiTranscript(
      { status: "completed", words: [{ text: "x", start: 0, end: 100 }] },
      PROVIDER_ID
    );
    expect(transcript.words[0].confidence).toBe(0.5);
  });

  it("clamps an out-of-range confidence into [0, 1]", () => {
    const transcript = convertAssemblyAiTranscript(
      { status: "completed", words: [{ text: "x", start: 0, end: 100, confidence: -3 }] },
      PROVIDER_ID
    );
    expect(transcript.words[0].confidence).toBe(0);
  });

  it("throws TranscriptInvalidPayloadError when neither utterances nor words is present", () => {
    expect(() => convertAssemblyAiTranscript({ status: "completed", text: "hi" }, PROVIDER_ID)).toThrow(
      TranscriptInvalidPayloadError
    );
  });

  it("throws TranscriptInvalidPayloadError when a word is missing start/end", () => {
    expect(() =>
      convertAssemblyAiTranscript({ status: "completed", words: [{ text: "x" }] }, PROVIDER_ID)
    ).toThrow(TranscriptInvalidPayloadError);
  });

  it("throws TranscriptInvalidPayloadError for a non-object payload", () => {
    expect(() => convertAssemblyAiTranscript(null, PROVIDER_ID)).toThrow(TranscriptInvalidPayloadError);
  });

  it("throws when utterances contain no words at all", () => {
    expect(() =>
      convertAssemblyAiTranscript(
        { status: "completed", utterances: [{ speaker: "A", start: 0, end: 10, words: [] }] },
        PROVIDER_ID
      )
    ).toThrow(TranscriptInvalidPayloadError);
  });
});
