import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import {
  EFFECT_TEMPLATE_IDS,
  ZOOM_SCALE_MIN,
  ZOOM_SCALE_MAX,
  FONT_SIZE_SCALE_MIN,
  FONT_SIZE_SCALE_MAX,
  MARGIN_SCALE_MIN,
  MARGIN_SCALE_MAX,
  DUCK_DB_MIN,
  DUCK_DB_MAX,
  ATTACK_SEC_MIN,
  ATTACK_SEC_MAX,
  RELEASE_SEC_MIN,
  RELEASE_SEC_MAX,
} from "./types";

const BASE_CONTEXT = { segmentId: "seg-1", segmentDurationSec: 12 };

describe("buildRenderPlan", () => {
  for (const templateId of EFFECT_TEMPLATE_IDS) {
    it(`produces a fully bounded plan for template "${templateId}"`, () => {
      const plan = buildRenderPlan(templateId, BASE_CONTEXT);

      expect(plan.templateId).toBe(templateId);
      expect(plan.intensity).toBeGreaterThanOrEqual(0);
      expect(plan.intensity).toBeLessThanOrEqual(1);

      for (const kf of plan.zoomKeyframes) {
        expect(kf.scale).toBeGreaterThanOrEqual(ZOOM_SCALE_MIN);
        expect(kf.scale).toBeLessThanOrEqual(ZOOM_SCALE_MAX);
        expect(kf.tSec).toBeGreaterThanOrEqual(0);
        expect(kf.tSec).toBeLessThanOrEqual(BASE_CONTEXT.segmentDurationSec);
      }

      expect(plan.subtitleStyle.fontSizeScale).toBeGreaterThanOrEqual(FONT_SIZE_SCALE_MIN);
      expect(plan.subtitleStyle.fontSizeScale).toBeLessThanOrEqual(FONT_SIZE_SCALE_MAX);
      expect(plan.subtitleStyle.marginVerticalScale).toBeGreaterThanOrEqual(MARGIN_SCALE_MIN);
      expect(plan.subtitleStyle.marginVerticalScale).toBeLessThanOrEqual(MARGIN_SCALE_MAX);
      expect(plan.subtitleStyle.primaryColorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);

      if (plan.audioDucking.enabled) {
        expect(plan.audioDucking.duckDb).toBeGreaterThanOrEqual(DUCK_DB_MIN);
        expect(plan.audioDucking.duckDb).toBeLessThanOrEqual(DUCK_DB_MAX);
        expect(plan.audioDucking.attackSec).toBeGreaterThanOrEqual(ATTACK_SEC_MIN);
        expect(plan.audioDucking.attackSec).toBeLessThanOrEqual(ATTACK_SEC_MAX);
        expect(plan.audioDucking.releaseSec).toBeGreaterThanOrEqual(RELEASE_SEC_MIN);
        expect(plan.audioDucking.releaseSec).toBeLessThanOrEqual(RELEASE_SEC_MAX);
      }

      expect(plan.safeZones.length).toBeGreaterThan(0);
      expect(plan.limitations.length).toBeGreaterThan(0);
    });
  }

  it("always emits a single cut spanning exactly [0, segmentDurationSec] (no cut-point detection in this MVP)", () => {
    const plan = buildRenderPlan("subtle-punch", BASE_CONTEXT);
    expect(plan.cuts).toEqual([{ startSec: 0, endSec: BASE_CONTEXT.segmentDurationSec }]);
  });

  it("documents in limitations that zoom keyframes are not yet frame-accurately rendered", () => {
    const plan = buildRenderPlan("hook-emphasis", BASE_CONTEXT);
    expect(plan.limitations.some((l) => /zoom/i.test(l))).toBe(true);
  });

  it("documents in limitations that audio ducking is declared but not applied", () => {
    const plan = buildRenderPlan("speaker-focus", BASE_CONTEXT);
    expect(plan.limitations.some((l) => /ducking|audio/i.test(l))).toBe(true);
  });

  it("never mentions watch time or virality anywhere in the plan", () => {
    for (const templateId of EFFECT_TEMPLATE_IDS) {
      const plan = buildRenderPlan(templateId, BASE_CONTEXT);
      const text = JSON.stringify(plan).toLowerCase();
      expect(text).not.toContain("watch time");
      expect(text).not.toContain("viral");
    }
  });

  it("gives hook-emphasis a larger subtitle font scale than clean-captions (differentiated templates)", () => {
    const hook = buildRenderPlan("hook-emphasis", BASE_CONTEXT);
    const clean = buildRenderPlan("clean-captions", BASE_CONTEXT);
    expect(hook.subtitleStyle.fontSizeScale).toBeGreaterThan(clean.subtitleStyle.fontSizeScale);
  });

  it("gives clean-captions the lowest overall intensity", () => {
    const intensities = EFFECT_TEMPLATE_IDS.map((id) => buildRenderPlan(id, BASE_CONTEXT).intensity);
    const cleanIntensity = buildRenderPlan("clean-captions", BASE_CONTEXT).intensity;
    expect(cleanIntensity).toBe(Math.min(...intensities));
  });

  it("places speaker-focus zoom keyframes near provided speaker-change times, clamped to the segment", () => {
    const plan = buildRenderPlan("speaker-focus", {
      ...BASE_CONTEXT,
      speakerChangeTimesSec: [3, 8, 50],
    });
    const times = plan.zoomKeyframes.map((k) => k.tSec);
    expect(times.some((t) => Math.abs(t - 3) < 0.01)).toBe(true);
    expect(times.some((t) => Math.abs(t - 8) < 0.01)).toBe(true);
    // 50 is beyond the 12s segment and must be clamped, not passed through as-is.
    expect(times.every((t) => t <= BASE_CONTEXT.segmentDurationSec)).toBe(true);
  });

  it("is deterministic across calls with the same input", () => {
    const a = buildRenderPlan("subtle-punch", BASE_CONTEXT);
    const b = buildRenderPlan("subtle-punch", BASE_CONTEXT);
    expect(a).toEqual(b);
  });

  it("throws for an unknown template id", () => {
    // @ts-expect-error intentionally invalid template id
    expect(() => buildRenderPlan("does-not-exist", BASE_CONTEXT)).toThrow();
  });

  it("handles a zero-duration segment without producing out-of-range keyframes", () => {
    const plan = buildRenderPlan("hook-emphasis", { segmentId: "seg-0", segmentDurationSec: 0 });
    expect(plan.cuts).toEqual([{ startSec: 0, endSec: 0 }]);
    for (const kf of plan.zoomKeyframes) {
      expect(kf.tSec).toBe(0);
    }
  });
});
