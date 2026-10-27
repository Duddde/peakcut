import { describe, expect, it } from "vitest";
import { mergeChunkTranscripts } from "./mergeChunkTranscripts";

const word = (text: string, startSec: number, speaker?: string) => ({
  text,
  startSec,
  endSec: startSec + 0.5,
  speaker,
  confidence: 0.9,
});

describe("mergeChunkTranscripts", () => {
  it("shifts each piece by its offset and keeps the recording's order, whatever the order of arrival", () => {
    const merged = mergeChunkTranscripts(
      [
        { offsetSec: 1300, transcript: { language: "fr", providerId: "x", words: [word("deux", 2, "A")] } },
        { offsetSec: 0, transcript: { language: "fr", providerId: "x", words: [word("un", 2, "A")] } },
      ],
      "openai"
    );

    expect(merged.providerId).toBe("openai");
    expect(merged.language).toBe("fr");
    expect(merged.words.map((w) => [w.text, w.startSec, w.endSec])).toEqual([
      ["un", 2, 2.5],
      ["deux", 1302, 1302.5],
    ]);
  });

  it("never assumes a speaker of one piece is the same person in another", () => {
    const merged = mergeChunkTranscripts(
      [
        { offsetSec: 0, transcript: { language: "fr", providerId: "x", words: [word("un", 0, "A"), word("deux", 1)] } },
        { offsetSec: 100, transcript: { language: "fr", providerId: "x", words: [word("trois", 0, "A")] } },
      ],
      "openai"
    );

    expect(merged.words.map((w) => w.speaker)).toEqual(["A·1", undefined, "A·2"]);
  });

  it("leaves a single piece's labels as they are", () => {
    const merged = mergeChunkTranscripts(
      [{ offsetSec: 0, transcript: { language: "fr", providerId: "x", words: [word("un", 0, "A")] } }],
      "openai"
    );
    expect(merged.words[0].speaker).toBe("A");
  });
});
