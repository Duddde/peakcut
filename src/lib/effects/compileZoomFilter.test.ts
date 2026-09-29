import { describe, expect, it } from "vitest";
import { compileZoomFilter } from "./compileZoomFilter";
import type { NormalizedRect } from "@/lib/domain/types";
import type { ZoomKeyframe } from "./types";

const FULL_FRAME: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const VERTICAL_CROP: NormalizedRect = { x: 0.3418, y: 0, width: 0.3164, height: 1 };

describe("compileZoomFilter", () => {
  it("falls back to a static (non-animated) crop when there are no zoom keyframes", () => {
    const result = compileZoomFilter({ baseCrop: VERTICAL_CROP, zoomKeyframes: [] });
    expect(result.zoomApplied).toBe(false);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.filterFragment).toContain("crop=");
    expect(result.filterFragment).not.toContain("lt(t");
  });

  it("falls back to a static crop when every keyframe has scale 1 (no-op zoom)", () => {
    const zoomKeyframes: ZoomKeyframe[] = [
      { tSec: 0, scale: 1 },
      { tSec: 5, scale: 1 },
    ];
    const result = compileZoomFilter({ baseCrop: VERTICAL_CROP, zoomKeyframes });
    expect(result.zoomApplied).toBe(false);
  });

  it("applies a static (non-time-varying) zoom for a single non-trivial keyframe", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1.1 }],
    });
    expect(result.zoomApplied).toBe(true);
    expect(result.filterFragment).not.toContain("lt(t");
  });

  it("builds a time-varying piecewise expression for two or more distinct keyframes", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.1 },
        { tSec: 10, scale: 1 },
      ],
    });
    expect(result.zoomApplied).toBe(true);
    expect(result.filterFragment).toContain("lt(t");
    expect(result.filterFragment).toContain("crop=");
    // Every crop parameter must be present.
    expect(result.filterFragment).toMatch(/w='[^']+'/);
    expect(result.filterFragment).toMatch(/h='[^']+'/);
    expect(result.filterFragment).toMatch(/x='[^']+'/);
    expect(result.filterFragment).toMatch(/y='[^']+'/);
  });

  it("clamps the zoom expression to [1, 1.15] regardless of input scale via clip()", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.15 },
      ],
    });
    expect(result.filterFragment).toContain("clip(");
    expect(result.filterFragment).toContain("1.15");
  });

  it("rejects an out-of-bounds scale rather than compiling it verbatim", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 50 },
      ],
    });
    expect(result.zoomApplied).toBe(false);
    expect(result.notes.some((n) => /borne|bound|extrême/i.test(n))).toBe(true);
  });

  it("dedupes keyframes sharing the same timestamp instead of dividing by zero", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.1 },
        { tSec: 5, scale: 1.1 },
        { tSec: 10, scale: 1 },
      ],
    });
    expect(result.zoomApplied).toBe(true);
    expect(result.filterFragment).not.toContain("NaN");
    expect(result.filterFragment).not.toContain("Infinity");
  });

  it("sorts out-of-order keyframes before compiling", () => {
    const outOfOrder = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 10, scale: 1 },
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.1 },
      ],
    });
    const sorted = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.1 },
        { tSec: 10, scale: 1 },
      ],
    });
    expect(outOfOrder.filterFragment).toBe(sorted.filterFragment);
  });

  it("embeds the base crop's normalized fractions using in_w/in_h so it is resolution-independent", () => {
    const result = compileZoomFilter({ baseCrop: FULL_FRAME, zoomKeyframes: [] });
    expect(result.filterFragment).toContain("in_w");
    expect(result.filterFragment).toContain("in_h");
  });

  it("is deterministic across calls", () => {
    const params = {
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.1 },
      ],
    };
    expect(compileZoomFilter(params)).toEqual(compileZoomFilter(params));
  });
});
