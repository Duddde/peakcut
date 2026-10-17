import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import { MIN_CUT_DURATION_SEC } from "./types";
import { retimeRenderPlan } from "./retimeRenderPlan";

const PLAN = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 });

describe("retimeRenderPlan", () => {
  it("follows the clip when it is trimmed", () => {
    const retimed = retimeRenderPlan(PLAN, 20);
    expect(retimed.cuts).toEqual([{ startSec: 0, endSec: 20 }]);
    expect(retimed.zoomKeyframes.every((kf) => kf.tSec <= 20)).toBe(true);
  });

  it("stays valid at every length, which is the whole point", () => {
    for (const duration of [0, 0.1, MIN_CUT_DURATION_SEC, 1, 20, 60, 600]) {
      expect(validateRenderPlan(retimeRenderPlan(PLAN, duration)).ok).toBe(true);
    }
  });

  it("keeps at least one keyframe, so the export never silently loses the zoom", () => {
    expect(retimeRenderPlan(PLAN, 0.5).zoomKeyframes.length).toBeGreaterThan(0);
  });

  it("drops the cut entirely for a clip too short to carry one", () => {
    const retimed = retimeRenderPlan(PLAN, MIN_CUT_DURATION_SEC / 2);
    expect(retimed.cuts).toEqual([]);
    expect(retimed.zoomKeyframes).toEqual([{ tSec: 0, scale: 1 }]);
  });

  it("leaves a plan already fitting its clip untouched", () => {
    expect(retimeRenderPlan(PLAN, 60)).toEqual(PLAN);
  });

  it("never invents a keyframe when the clip is extended", () => {
    expect(retimeRenderPlan(PLAN, 120).zoomKeyframes).toEqual(PLAN.zoomKeyframes);
  });

  it("keeps the template, the caption style and the declared limitations", () => {
    const retimed = retimeRenderPlan(PLAN, 10);
    expect(retimed.templateId).toBe(PLAN.templateId);
    expect(retimed.subtitleStyle).toEqual(PLAN.subtitleStyle);
    expect(retimed.limitations).toEqual(PLAN.limitations);
  });
});
