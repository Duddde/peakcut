import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import {
  MAX_OVERLAYS_PER_PLAN,
  MIN_OVERLAY_DURATION_SEC,
  OVERLAY_FADE_SEC_MAX,
  type RenderPlan,
} from "./types";
import {
  canAddOverlay,
  defaultOverlayFor,
  fitOverlay,
  patchOverlay,
  planDurationSec,
  withOverlay,
  withoutOverlay,
} from "./overlayEdits";

const ASSET = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";

function plan(durationSec = 60): RenderPlan {
  return buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: durationSec });
}

describe("planDurationSec", () => {
  it("reads the clip length from the plan itself", () => {
    expect(planDurationSec(plan(42))).toBe(42);
  });

  it("is 0 for a plan with no cut at all", () => {
    expect(planDurationSec({ ...plan(), cuts: [] })).toBe(0);
  });
});

describe("defaultOverlayFor", () => {
  it("places a new illustration a quarter into the clip, for a few seconds", () => {
    const overlay = defaultOverlayFor({ assetId: ASSET, id: "ov-1", durationSec: 60 });
    expect(overlay.startSec).toBe(15);
    expect(overlay.endSec).toBe(18);
    expect(overlay.assetId).toBe(ASSET);
  });

  it("staggers a second illustration so it does not land on the first", () => {
    const first = defaultOverlayFor({ assetId: ASSET, id: "a", durationSec: 60, index: 0 });
    const second = defaultOverlayFor({ assetId: ASSET, id: "b", durationSec: 60, index: 1 });
    expect(second.startSec).toBeGreaterThanOrEqual(first.endSec);
  });

  it("produces a valid plan even on a very short clip", () => {
    for (const duration of [0.5, 1, 3, 10, 95]) {
      const base = plan(duration);
      const withIt = withOverlay(base, defaultOverlayFor({ assetId: ASSET, id: "ov", durationSec: duration }));
      expect(validateRenderPlan(withIt).ok).toBe(true);
    }
  });
});

describe("withOverlay", () => {
  it("adds the illustration to the plan", () => {
    const next = withOverlay(plan(), defaultOverlayFor({ assetId: ASSET, id: "ov-1", durationSec: 60 }));
    expect(next.overlays.map((o) => o.id)).toEqual(["ov-1"]);
    expect(validateRenderPlan(next).ok).toBe(true);
  });

  it("refuses to go past the cap, rather than building a plan the server rejects", () => {
    let current = plan();
    for (let i = 0; i < MAX_OVERLAYS_PER_PLAN + 3; i++) {
      current = withOverlay(current, defaultOverlayFor({ assetId: ASSET, id: `ov-${i}`, durationSec: 60 }));
    }
    expect(current.overlays).toHaveLength(MAX_OVERLAYS_PER_PLAN);
    expect(canAddOverlay(current)).toBe(false);
    expect(validateRenderPlan(current).ok).toBe(true);
  });

  it("brings an illustration that would sit outside the clip back inside it", () => {
    const next = withOverlay(plan(10), {
      id: "ov-1",
      assetId: ASSET,
      startSec: 30,
      endSec: 40,
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
      opacity: 1,
      fadeSec: 0,
    });
    expect(next.overlays[0].endSec).toBeLessThanOrEqual(10);
    expect(validateRenderPlan(next).ok).toBe(true);
  });
});

describe("withoutOverlay", () => {
  it("removes exactly the illustration asked for", () => {
    const base = withOverlay(
      withOverlay(plan(), defaultOverlayFor({ assetId: ASSET, id: "a", durationSec: 60 })),
      defaultOverlayFor({ assetId: ASSET, id: "b", durationSec: 60, index: 1 })
    );
    expect(withoutOverlay(base, "a").overlays.map((o) => o.id)).toEqual(["b"]);
  });

  it("is a no-op for an unknown id", () => {
    const base = withOverlay(plan(), defaultOverlayFor({ assetId: ASSET, id: "a", durationSec: 60 }));
    expect(withoutOverlay(base, "inconnu")).toEqual(base);
  });
});

describe("patchOverlay", () => {
  const base = withOverlay(plan(60), defaultOverlayFor({ assetId: ASSET, id: "ov-1", durationSec: 60 }));

  it("moves the illustration in time", () => {
    const patched = patchOverlay(base, "ov-1", { startSec: 30, endSec: 36 });
    expect(patched.overlays[0]).toMatchObject({ startSec: 30, endSec: 36 });
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("never lets the end cross the start", () => {
    const patched = patchOverlay(base, "ov-1", { startSec: 20, endSec: 5 });
    const overlay = patched.overlays[0];
    expect(overlay.endSec - overlay.startSec).toBeGreaterThanOrEqual(MIN_OVERLAY_DURATION_SEC);
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("keeps the illustration inside the clip", () => {
    const patched = patchOverlay(base, "ov-1", { startSec: 500, endSec: 900 });
    expect(patched.overlays[0].endSec).toBeLessThanOrEqual(60);
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("shortens a fade that would outrun the illustration", () => {
    const patched = patchOverlay(base, "ov-1", { startSec: 10, endSec: 11, fadeSec: OVERLAY_FADE_SEC_MAX });
    expect(patched.overlays[0].fadeSec).toBeLessThanOrEqual(0.5);
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("clamps an opacity of zero up to the lowest visible one", () => {
    const patched = patchOverlay(base, "ov-1", { opacity: 0 });
    expect(patched.overlays[0].opacity).toBeGreaterThan(0);
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("brings a box that leaves the frame back inside it, keeping its size", () => {
    const patched = patchOverlay(base, "ov-1", { rect: { x: 0.9, y: 0.9, width: 0.5, height: 0.4 } });
    const rect = patched.overlays[0].rect;
    expect(rect.width).toBe(0.5);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    expect(validateRenderPlan(patched).ok).toBe(true);
  });

  it("leaves the other illustrations alone", () => {
    const two = withOverlay(base, defaultOverlayFor({ assetId: ASSET, id: "ov-2", durationSec: 60, index: 1 }));
    const patched = patchOverlay(two, "ov-1", { opacity: 0.5 });
    expect(patched.overlays[1]).toEqual(two.overlays[1]);
  });
});

describe("fitOverlay", () => {
  it("always produces something the validator accepts, whatever it is given", () => {
    const absurd = {
      id: "ov",
      assetId: ASSET,
      startSec: -50,
      endSec: -10,
      rect: { x: -1, y: 2, width: 5, height: -3 },
      opacity: 99,
      fadeSec: 99,
    };
    for (const duration of [0.5, 1, 20, 95]) {
      const fitted = fitOverlay(absurd, duration);
      const result = validateRenderPlan({ ...plan(duration), overlays: [fitted] });
      expect(result.errors).toEqual([]);
    }
  });
});
