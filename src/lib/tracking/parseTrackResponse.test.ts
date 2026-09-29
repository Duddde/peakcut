import { describe, expect, it } from "vitest";
import { parseTrackResponse, TrackResponseParseError } from "./parseTrackResponse";

function valid() {
  return {
    ok: true,
    provider: "stable-center-fallback",
    track: {
      keyframes: [
        { t_sec: 0, cx: 0.5, cy: 0.5, confidence: 0.3 },
        { t_sec: 10, cx: 0.5, cy: 0.5, confidence: 0.3 },
      ],
      fallback_used: true,
      method: "centered-fallback-no-face-model",
    },
  };
}

describe("parseTrackResponse", () => {
  it("parses a well-formed response", () => {
    const result = parseTrackResponse(valid());
    expect(result.provider).toBe("stable-center-fallback");
    expect(result.track.fallbackUsed).toBe(true);
    expect(result.track.method).toBe("centered-fallback-no-face-model");
    expect(result.track.keyframes).toEqual([
      { tSec: 0, cx: 0.5, cy: 0.5, confidence: 0.3 },
      { tSec: 10, cx: 0.5, cy: 0.5, confidence: 0.3 },
    ]);
  });

  it("throws when ok is not true", () => {
    expect(() => parseTrackResponse({ ok: false })).toThrow(TrackResponseParseError);
  });

  it("throws when track is missing", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.track;
    expect(() => parseTrackResponse(payload)).toThrow(TrackResponseParseError);
  });

  it("throws when keyframes is not an array", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    payload.track.keyframes = "nope";
    expect(() => parseTrackResponse(payload)).toThrow(TrackResponseParseError);
  });

  it("throws when a keyframe is missing a required field", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.track.keyframes[0].confidence;
    expect(() => parseTrackResponse(payload)).toThrow(TrackResponseParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseTrackResponse(null)).toThrow(TrackResponseParseError);
  });
});
