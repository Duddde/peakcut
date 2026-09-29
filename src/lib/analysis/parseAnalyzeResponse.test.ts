import { describe, expect, it } from "vitest";
import { AnalyzeResponseParseError, parseAnalyzeResponse } from "./parseAnalyzeResponse";

function validPayload() {
  return {
    ok: true,
    segments: [
      {
        id: "seg-1",
        rank: 1,
        title: "Titre",
        start_sec: 0,
        end_sec: 5,
        score: 72,
        confidence: 0.6,
        score_breakdown: {
          hook: 0.8,
          lexical_density: 0.5,
          question: 0,
          emotion: 0.2,
          speaker_change: 0.1,
          duration: 0.9,
          penalties: 0,
        },
        categories: ["accroche"],
        reasons: ["raison 1"],
        penalty_reasons: [],
        words: [
          { text: "Bonjour", start_sec: 0, end_sec: 0.4, speaker: "A", confidence: 0.9 },
          { text: "le", start_sec: 0.45, end_sec: 0.6, speaker: "A", confidence: 0.9 },
        ],
        safe_zones: [
          {
            id: "sz-1",
            purpose: "subtitle-area",
            label: "Zone sous-titres",
            rect: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
          },
        ],
        variants: [
          {
            id: "v-1",
            label: "Vertical",
            aspect_ratio: "9:16",
            crop: { x: 0.34, y: 0, width: 0.32, height: 1 },
          },
        ],
      },
    ],
  };
}

describe("parseAnalyzeResponse", () => {
  it("parses a well-formed payload into internal Segment shape", () => {
    const segments = parseAnalyzeResponse(validPayload());
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.id).toBe("seg-1");
    expect(seg.rank).toBe(1);
    expect(seg.categories).toEqual(["accroche"]);
    expect(seg.startSec).toBe(0);
    expect(seg.endSec).toBe(5);
    expect(seg.words).toHaveLength(2);
    expect(seg.words[0]).toEqual({
      text: "Bonjour",
      startSec: 0,
      endSec: 0.4,
      speaker: "A",
      confidence: 0.9,
    });
    expect(seg.safeZones[0].purpose).toBe("subtitle-area");
    expect(seg.variants[0].aspectRatio).toBe("9:16");
    expect(seg.score?.value).toBe(72);
    expect(seg.score?.explanation.breakdown.lexicalDensity).toBe(0.5);
    expect(seg.score?.explanation.breakdown.speakerChange).toBe(0.1);
  });

  it("throws AnalyzeResponseParseError when ok is not true", () => {
    expect(() => parseAnalyzeResponse({ ok: false, segments: [] })).toThrow(
      AnalyzeResponseParseError
    );
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseAnalyzeResponse(null)).toThrow(AnalyzeResponseParseError);
    expect(() => parseAnalyzeResponse("oops")).toThrow(AnalyzeResponseParseError);
  });

  it("throws when segments is missing or not an array", () => {
    expect(() => parseAnalyzeResponse({ ok: true })).toThrow(AnalyzeResponseParseError);
    expect(() => parseAnalyzeResponse({ ok: true, segments: "nope" })).toThrow(
      AnalyzeResponseParseError
    );
  });

  it("throws when a segment is missing id or title", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed for the test
    delete payload.segments[0].id;
    expect(() => parseAnalyzeResponse(payload)).toThrow(AnalyzeResponseParseError);
  });

  it("throws when a word is missing required numeric fields", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed for the test
    payload.segments[0].words[0].start_sec = "not-a-number";
    expect(() => parseAnalyzeResponse(payload)).toThrow(AnalyzeResponseParseError);
  });

  it("throws when score_breakdown is missing a required field", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed for the test
    delete payload.segments[0].score_breakdown.speaker_change;
    expect(() => parseAnalyzeResponse(payload)).toThrow(AnalyzeResponseParseError);
  });

  it("falls back score to null when score fields are absent (e.g. an empty segment)", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed for the test
    delete payload.segments[0].score;
    // @ts-expect-error intentionally malformed for the test
    delete payload.segments[0].score_breakdown;
    const segments = parseAnalyzeResponse(payload);
    expect(segments[0].score).toBeNull();
  });

  it("returns an empty array for an empty segments list", () => {
    expect(parseAnalyzeResponse({ ok: true, segments: [] })).toEqual([]);
  });
});
