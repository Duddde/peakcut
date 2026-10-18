import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import {
  EFFECT_TEMPLATE_IDS,
  ZOOM_SCALE_MIN,
  ZOOM_SCALE_MAX,
  FONT_SIZE_SCALE_MIN,
  FONT_SIZE_SCALE_MAX,
  MARGIN_SCALE_MIN,
  MARGIN_SCALE_MAX,
  MIN_CUT_DURATION_SEC,
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

  /**
   * The zoom used to be listed as not-yet-applied. exportSegment now
   * compiles these keyframes into a real animated crop, so claiming
   * otherwise would understate what the export does — and a limitation
   * that depends on the call (no base crop, invalid plan) is reported by
   * the export itself, per render.
   */
  it("no longer claims the zoom is unapplied, but still declares what is", () => {
    const plan = buildRenderPlan("hook-emphasis", BASE_CONTEXT);
    expect(plan.limitations.some((l) => /zoom/i.test(l))).toBe(false);
    expect(plan.limitations.some((l) => /ducking/i.test(l))).toBe(true);
    expect(plan.limitations.some((l) => /coupes/i.test(l))).toBe(true);
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

  /**
   * It used to emit a zero-length cut here, which is precisely what
   * validateRenderPlan rejects — so the plan failed its own validator and
   * the export fell back to a static crop without anyone saying why.
   */
  it("degrades a segment too short to edit into a valid, empty plan", () => {
    for (const segmentDurationSec of [0, MIN_CUT_DURATION_SEC / 2]) {
      const plan = buildRenderPlan("hook-emphasis", { segmentId: "seg-0", segmentDurationSec });
      expect(plan.cuts).toEqual([]);
      expect(plan.zoomKeyframes).toEqual([{ tSec: 0, scale: 1 }]);
      expect(validateRenderPlan(plan).ok).toBe(true);
    }
  });

  it("emits one cut covering the whole clip as soon as it is long enough to edit", () => {
    const plan = buildRenderPlan("hook-emphasis", { segmentId: "seg-0", segmentDurationSec: 30 });
    expect(plan.cuts).toEqual([{ startSec: 0, endSec: 30 }]);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });
});

describe("buildRenderPlan \u2014 effets 3D", () => {
  it("pose l'ouverture de hook-emphasis et laisse les autres modeles a plat", () => {
    const hook = buildRenderPlan("hook-emphasis", { segmentId: "s", segmentDurationSec: 30 });
    expect(hook.perspectiveMoves).toHaveLength(1);
    expect(hook.perspectiveMoves[0]).toMatchObject({ startSec: 0, profile: "settle" });
    expect(validateRenderPlan(hook).ok).toBe(true);

    for (const templateId of ["subtle-punch", "speaker-focus", "clean-captions"] as const) {
      const plan = buildRenderPlan(templateId, { segmentId: "s", segmentDurationSec: 30 });
      expect(plan.perspectiveMoves).toEqual([]);
    }
  });

  it("est deterministe : deux plans du meme clip portent le meme mouvement", () => {
    const a = buildRenderPlan("hook-emphasis", { segmentId: "s", segmentDurationSec: 30 });
    const b = buildRenderPlan("hook-emphasis", { segmentId: "s", segmentDurationSec: 30 });
    expect(a.perspectiveMoves).toEqual(b.perspectiveMoves);
  });

  it("n'ouvre pas sur un mouvement qu'un clip tres court ne pourrait pas tenir", () => {
    const plan = buildRenderPlan("hook-emphasis", { segmentId: "s", segmentDurationSec: 0.25 });
    expect(plan.perspectiveMoves).toEqual([]);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });
});
