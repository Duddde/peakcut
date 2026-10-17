import { describe, expect, it } from "vitest";
import {
  OVERLAY_PLACEMENTS,
  OVERLAY_SIZE_MAX,
  OVERLAY_SIZE_MIN,
  placementOf,
  placementRect,
  sizeOf,
} from "./overlayPlacement";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";

describe("placementRect", () => {
  it("keeps every placement inside the frame, at every size", () => {
    for (const placement of OVERLAY_PLACEMENTS) {
      for (const size of [OVERLAY_SIZE_MIN, 0.5, 0.9, OVERLAY_SIZE_MAX]) {
        const rect = placementRect(placement, size);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("centers every placement horizontally", () => {
    for (const placement of OVERLAY_PLACEMENTS) {
      const rect = placementRect(placement, 0.6);
      expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 6);
    }
  });

  it("fills the frame for the full placement, whatever the size asked for", () => {
    expect(placementRect("full", 0.3)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("makes a box that is square in pixels on a 1080x1920 frame", () => {
    const rect = placementRect("top", 0.8);
    expect(rect.width * 1080).toBeCloseTo(rect.height * 1920, 6);
  });

  it("leaves the subtitle area clear for everything but the full placement", () => {
    const subtitleArea = buildDefaultSafeZones("seg").find((zone) => zone.purpose === "subtitle-area")!;
    for (const placement of ["top", "center", "bottom"] as const) {
      const rect = placementRect(placement, OVERLAY_SIZE_MAX);
      expect(rect.y + rect.height).toBeLessThanOrEqual(subtitleArea.rect.y);
    }
  });

  it("clamps a size outside the slider range", () => {
    expect(placementRect("top", 5).width).toBe(OVERLAY_SIZE_MAX);
    expect(placementRect("top", 0).width).toBe(OVERLAY_SIZE_MIN);
  });
});

describe("placementOf", () => {
  it("recognizes each placement it produced", () => {
    for (const placement of OVERLAY_PLACEMENTS) {
      expect(placementOf(placementRect(placement, 0.7))).toBe(placement);
    }
  });

  it("falls back to the nearest named place for a rectangle from somewhere else", () => {
    expect(placementOf({ x: 0.1, y: 0.05, width: 0.8, height: 0.45 })).toBe("top");
    expect(placementOf({ x: 0.1, y: 0.5, width: 0.8, height: 0.2 })).toBe("bottom");
  });
});

describe("sizeOf", () => {
  it("reads back the size a placement was built with", () => {
    expect(sizeOf(placementRect("center", 0.45))).toBeCloseTo(0.45, 6);
  });

  it("stays inside the slider range for a rectangle built elsewhere", () => {
    expect(sizeOf({ x: 0, y: 0, width: 0.01, height: 0.01 })).toBe(OVERLAY_SIZE_MIN);
  });
});
