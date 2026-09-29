import { describe, expect, it } from "vitest";
import { analyzeMockTranscript } from "./analyzeMockTranscript";

describe("analyzeMockTranscript", () => {
  it("returns the mock transcript alongside ranked segments", async () => {
    const result = await analyzeMockTranscript();
    expect(result.transcript.words.length).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
  });

  it("ranks segments by descending score and assigns a 1-based rank", async () => {
    const result = await analyzeMockTranscript();
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i - 1].score!.value).toBeGreaterThanOrEqual(result.segments[i].score!.value);
    }
    expect(result.segments.map((s) => s.rank)).toEqual(
      result.segments.map((_, i) => i + 1)
    );
  });

  it("gives every segment a score breakdown, categories, reasons and confidence", async () => {
    const result = await analyzeMockTranscript();
    for (const segment of result.segments) {
      expect(segment.score).not.toBeNull();
      expect(segment.score!.explanation.breakdown).toBeDefined();
      expect(segment.score!.confidence).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(segment.categories)).toBe(true);
    }
  });

  it("never mentions watch time or virality anywhere in the output", async () => {
    const result = await analyzeMockTranscript();
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain("watch time");
    expect(text).not.toContain("viral");
  });

  it("is deterministic across calls", async () => {
    const a = await analyzeMockTranscript();
    const b = await analyzeMockTranscript();
    expect(a).toEqual(b);
  });
});
