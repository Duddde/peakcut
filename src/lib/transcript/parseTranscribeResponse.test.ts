import { describe, expect, it } from "vitest";
import { parseTranscribeResponse, TranscribeResponseParseError } from "./parseTranscribeResponse";

function valid() {
  return {
    ok: true,
    provider_id: "mock-deterministic",
    transcript: {
      language: "fr",
      words: [
        { text: "Bonjour", start_sec: 0, end_sec: 0.4, speaker: "A", confidence: 0.9 },
        { text: "monde", start_sec: 0.5, end_sec: 0.9, speaker: null, confidence: 0.85 },
      ],
    },
  };
}

describe("parseTranscribeResponse", () => {
  it("parses a well-formed response into providerId + Transcript", () => {
    const result = parseTranscribeResponse(valid());
    expect(result.providerId).toBe("mock-deterministic");
    expect(result.transcript.language).toBe("fr");
    expect(result.transcript.providerId).toBe("mock-deterministic");
    expect(result.transcript.words).toHaveLength(2);
    expect(result.transcript.words[0]).toEqual({
      text: "Bonjour",
      startSec: 0,
      endSec: 0.4,
      speaker: "A",
      confidence: 0.9,
    });
    expect(result.transcript.words[1].speaker).toBeUndefined();
  });

  it("throws when ok is not true", () => {
    expect(() => parseTranscribeResponse({ ok: false, error: "x" })).toThrow(
      TranscribeResponseParseError
    );
  });

  it("throws when provider_id is missing", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.provider_id;
    expect(() => parseTranscribeResponse(payload)).toThrow(TranscribeResponseParseError);
  });

  it("throws when transcript is missing", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.transcript;
    expect(() => parseTranscribeResponse(payload)).toThrow(TranscribeResponseParseError);
  });

  it("throws when a word is missing start_sec/end_sec", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.transcript.words[0].start_sec;
    expect(() => parseTranscribeResponse(payload)).toThrow(TranscribeResponseParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseTranscribeResponse(null)).toThrow(TranscribeResponseParseError);
  });

  it("defaults language to 'fr' when absent", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.transcript.language;
    const result = parseTranscribeResponse(payload);
    expect(result.transcript.language).toBe("fr");
  });
});
