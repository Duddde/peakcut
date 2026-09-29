import { describe, expect, it } from "vitest";
import { deriveCropFromTrack } from "./deriveCropFromTrack";
import type { FrameTrack } from "./types";

function centeredTrack(): FrameTrack {
  return {
    keyframes: [
      { tSec: 0, cx: 0.5, cy: 0.5, confidence: 0.3 },
      { tSec: 10, cx: 0.5, cy: 0.5, confidence: 0.3 },
    ],
    fallbackUsed: true,
    method: "centered-fallback-no-face-model",
  };
}

describe("deriveCropFromTrack", () => {
  it("produces a centered 9:16 crop from a 16:9 source with a centered track", () => {
    const rect = deriveCropFromTrack(centeredTrack(), {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 5,
    });
    expect(rect.height).toBe(1);
    expect(rect.width).toBeCloseTo((9 / 16) / (1920 / 1080), 4);
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2, 4);
    expect(rect.y).toBe(0);
  });

  it("produces height < 1 when the target is wider than the source aspect", () => {
    const rect = deriveCropFromTrack(centeredTrack(), {
      targetAspect: 1,
      sourceWidth: 1080,
      sourceHeight: 1920,
      atSec: 0,
    });
    expect(rect.width).toBe(1);
    expect(rect.height).toBeLessThan(1);
  });

  it("keeps the crop within [0,1] bounds when the tracked center is near an edge", () => {
    const track: FrameTrack = {
      keyframes: [{ tSec: 0, cx: 0.02, cy: 0.5, confidence: 0.3 }],
      fallbackUsed: true,
      method: "centered-fallback-no-face-model",
    };
    const rect = deriveCropFromTrack(track, {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 0,
    });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("clamps similarly near the opposite edge", () => {
    const track: FrameTrack = {
      keyframes: [{ tSec: 0, cx: 0.98, cy: 0.5, confidence: 0.3 }],
      fallbackUsed: true,
      method: "centered-fallback-no-face-model",
    };
    const rect = deriveCropFromTrack(track, {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 0,
    });
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(rect.x).toBeGreaterThanOrEqual(0);
  });

  it("linearly interpolates the center between two keyframes", () => {
    const track: FrameTrack = {
      keyframes: [
        { tSec: 0, cx: 0.3, cy: 0.5, confidence: 0.3 },
        { tSec: 10, cx: 0.7, cy: 0.5, confidence: 0.3 },
      ],
      fallbackUsed: true,
      method: "centered-fallback-no-face-model",
    };
    const rectAtStart = deriveCropFromTrack(track, {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 0,
    });
    const rectAtMid = deriveCropFromTrack(track, {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 5,
    });
    const rectAtEnd = deriveCropFromTrack(track, {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 10,
    });
    expect(rectAtMid.x).toBeGreaterThan(rectAtStart.x);
    expect(rectAtEnd.x).toBeGreaterThan(rectAtMid.x);
  });

  it("clamps atSec before the first keyframe to the first keyframe's center", () => {
    const rect = deriveCropFromTrack(centeredTrack(), {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: -5,
    });
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2, 4);
  });

  it("clamps atSec after the last keyframe to the last keyframe's center", () => {
    const rect = deriveCropFromTrack(centeredTrack(), {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 999,
    });
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2, 4);
  });

  it("falls back to a centered crop for an empty track", () => {
    const rect = deriveCropFromTrack(
      { keyframes: [], fallbackUsed: true, method: "centered-fallback-no-face-model" },
      { targetAspect: 9 / 16, sourceWidth: 1920, sourceHeight: 1080, atSec: 0 }
    );
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2, 4);
  });

  it("returns the full frame when target aspect equals source aspect", () => {
    const rect = deriveCropFromTrack(centeredTrack(), {
      targetAspect: 16 / 9,
      sourceWidth: 1920,
      sourceHeight: 1080,
      atSec: 0,
    });
    expect(rect.width).toBeCloseTo(1, 4);
    expect(rect.height).toBeCloseTo(1, 4);
  });
});
