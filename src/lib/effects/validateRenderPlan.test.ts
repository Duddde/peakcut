import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import type { RenderPlan } from "./types";

function validPlan(): RenderPlan {
  return buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 10 });
}

describe("validateRenderPlan", () => {
  it("accepts a plan produced by buildRenderPlan for every template", () => {
    for (const templateId of ["subtle-punch", "speaker-focus", "hook-emphasis", "clean-captions"] as const) {
      const plan = buildRenderPlan(templateId, { segmentId: "s", segmentDurationSec: 15 });
      expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
    }
  });

  it("rejects a zoom scale above the maximum (extreme zoom)", () => {
    const plan = validPlan();
    plan.zoomKeyframes = [{ tSec: 0, scale: 5 }];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /zoom/i.test(e))).toBe(true);
  });

  it("rejects a zoom scale below the minimum", () => {
    const plan = validPlan();
    plan.zoomKeyframes = [{ tSec: 0, scale: 0.5 }];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects an intensity outside [0, 1]", () => {
    const plan = validPlan();
    plan.intensity = 1.5;
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /intensité|intensity/i.test(e))).toBe(true);
  });

  it("rejects a negative intensity", () => {
    const plan = validPlan();
    plan.intensity = -0.1;
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects a subtitle font scale outside its bounds", () => {
    const plan = validPlan();
    plan.subtitleStyle.fontSizeScale = 3;
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /police|font/i.test(e))).toBe(true);
  });

  it("rejects a subtitle color that is not a valid hex color", () => {
    const plan = validPlan();
    plan.subtitleStyle.primaryColorHex = "red";
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects an out-of-bounds margin scale", () => {
    const plan = validPlan();
    plan.subtitleStyle.marginVerticalScale = 10;
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects out-of-bounds audio ducking parameters when ducking is enabled", () => {
    const plan = validPlan();
    plan.audioDucking = { enabled: true, duckDb: -40, attackSec: 0.08, releaseSec: 0.4 };
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ducking|db/i.test(e))).toBe(true);
  });

  it("ignores out-of-bounds ducking parameters when ducking is disabled", () => {
    const plan = validPlan();
    plan.audioDucking = { enabled: false, duckDb: -999, attackSec: 99, releaseSec: 99 };
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("rejects cuts that fall outside the segment's own duration", () => {
    const plan = validPlan();
    plan.cuts = [{ startSec: -1, endSec: 5 }];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects a cut with endSec <= startSec", () => {
    const plan = validPlan();
    plan.cuts = [{ startSec: 5, endSec: 5 }];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects a cut shorter than the minimum cut duration", () => {
    const plan = validPlan();
    plan.cuts = [{ startSec: 0, endSec: 0.05 }];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects overlapping cuts", () => {
    const plan = validPlan();
    plan.cuts = [
      { startSec: 0, endSec: 5 },
      { startSec: 4, endSec: 8 },
    ];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /chevauch|overlap/i.test(e))).toBe(true);
  });

  it("rejects an empty safeZones list", () => {
    const plan = validPlan();
    plan.safeZones = [];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects a plan with no limitations declared (must always be transparent)", () => {
    const plan = validPlan();
    plan.limitations = [];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("rejects a zoom keyframe timestamp outside the segment's cut range", () => {
    const plan = validPlan();
    plan.cuts = [{ startSec: 0, endSec: 10 }];
    plan.zoomKeyframes = [{ tSec: 999, scale: 1.05 }];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("collects multiple errors at once rather than stopping at the first", () => {
    const plan = validPlan();
    plan.intensity = 5;
    plan.subtitleStyle.fontSizeScale = 100;
    const result = validateRenderPlan(plan);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
