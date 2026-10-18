import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import { MIN_CUT_DURATION_SEC, MIN_FRAMING_SHOT_DURATION_SEC, type FramingShot, type Overlay } from "./types";
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

describe("retimeRenderPlan overlays", () => {
  const overlay: Overlay = {
    id: "ov-1",
    assetId: "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c",
    startSec: 10,
    endSec: 30,
    rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
    opacity: 1,
    fadeSec: 0.5,
  };

  it("shortens an illustration that now runs past the end of the clip", () => {
    const retimed = retimeRenderPlan({ ...PLAN, overlays: [overlay] }, 20);
    expect(retimed.overlays).toEqual([{ ...overlay, endSec: 20 }]);
  });

  it("drops an illustration the trim left too brief to see", () => {
    const retimed = retimeRenderPlan({ ...PLAN, overlays: [overlay] }, 10.1);
    expect(retimed.overlays).toEqual([]);
  });

  it("shortens the fade with the illustration, so the plan stays valid", () => {
    const retimed = retimeRenderPlan({ ...PLAN, overlays: [{ ...overlay, startSec: 0, endSec: 30 }] }, 0.6);
    expect(retimed.overlays[0].fadeSec).toBe(0.3);
    expect(validateRenderPlan(retimed).ok).toBe(true);
  });

  it("leaves an illustration already inside the clip untouched", () => {
    expect(retimeRenderPlan({ ...PLAN, overlays: [overlay] }, 60).overlays).toEqual([overlay]);
  });
});

function framingShot(id: string, startSec: number, endSec: number, x: number): FramingShot {
  return {
    id,
    startSec,
    endSec,
    rect: { x, y: 0, width: 0.5625, height: 1 },
    transitionSec: 0,
    source: "speaker",
    label: "Intervenant A",
  };
}

describe("retimeRenderPlan — cadrage par plans", () => {
  const framed = {
    ...PLAN,
    framing: [
      framingShot("shot-1", 0, 20, 0.05),
      framingShot("shot-2", 20, 40, 0.39),
      framingShot("shot-3", 40, 60, 0.05),
    ],
  };

  it("garde les plans qui tiennent encore dans le clip rogné", () => {
    const retimed = retimeRenderPlan(framed, 40);
    expect(retimed.framing.map((shot) => shot.id)).toEqual(["shot-1", "shot-2"]);
    expect(retimed.framing[1].endSec).toBe(40);
    expect(validateRenderPlan(retimed)).toEqual({ ok: true, errors: [] });
  });

  it("raccourcit le plan qui dépasse la nouvelle fin", () => {
    const retimed = retimeRenderPlan(framed, 30);
    expect(retimed.framing).toHaveLength(2);
    expect(retimed.framing[1].endSec).toBe(30);
  });

  it("donne au plan précédent le bout de clip qu'un plan trop court laisserait découvert", () => {
    // Trimming to 20.1 s leaves shot-2 with a tenth of a second: dropping
    // it would end the clip on the base framing instead of on a speaker.
    const retimed = retimeRenderPlan(framed, 20.1);
    expect(retimed.framing.map((shot) => shot.id)).toEqual(["shot-1"]);
    expect(retimed.framing[0].endSec).toBeCloseTo(20.1, 6);
    expect(retimed.framing[0].endSec - retimed.framing[0].startSec).toBeGreaterThanOrEqual(
      MIN_FRAMING_SHOT_DURATION_SEC
    );
  });

  it("couvre toujours le clip sans trou après un rognage", () => {
    const retimed = retimeRenderPlan(framed, 45);
    expect(retimed.framing[0].startSec).toBe(0);
    for (let i = 1; i < retimed.framing.length; i++) {
      expect(retimed.framing[i].startSec).toBeCloseTo(retimed.framing[i - 1].endSec, 6);
    }
    expect(retimed.framing[retimed.framing.length - 1].endSec).toBe(45);
  });

  it("raccourcit la transition avec le plan qu'elle ouvre", () => {
    const withPan = {
      ...framed,
      framing: [framingShot("shot-1", 0, 20, 0.05), { ...framingShot("shot-2", 20, 40, 0.39), transitionSec: 0.8 }],
    };
    const retimed = retimeRenderPlan(withPan, 20.6);
    const last = retimed.framing[retimed.framing.length - 1];
    // The invariant is the one the validator enforces: a pan can never be
    // longer than the shot it opens.
    expect(last.transitionSec).toBeLessThanOrEqual(last.endSec - last.startSec);
    expect(last.transitionSec).toBeLessThan(0.8);
    expect(validateRenderPlan(retimed).ok).toBe(true);
  });

  it("vide le cadrage quand le clip devient trop court pour porter une coupe", () => {
    const retimed = retimeRenderPlan(framed, MIN_CUT_DURATION_SEC / 2);
    expect(retimed.framing).toEqual([]);
  });

  it("ne touche pas à un plan sans cadrage", () => {
    const retimed = retimeRenderPlan(PLAN, 30);
    expect(retimed.framing).toEqual([]);
  });
});

describe("retimeRenderPlan — décalage du début du clip", () => {
  const framed = {
    ...PLAN,
    framing: [
      framingShot("shot-1", 0, 20, 0.05),
      framingShot("shot-2", 20, 40, 0.39),
      framingShot("shot-3", 40, 60, 0.05),
    ],
    overlays: [
      {
        id: "ov-1",
        assetId: "11111111-1111-4111-8111-111111111111",
        startSec: 45,
        endSec: 50,
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
        opacity: 1,
        fadeSec: 0.2,
      } satisfies Overlay,
    ],
  };

  it("ramène les plans de cadrage sur la portion de vidéo qui reste", () => {
    // The clip now starts 40 s later: what was the third shot is the only
    // one left, and it starts at the beginning of the new clip.
    const retimed = retimeRenderPlan(framed, 20, 40);
    expect(retimed.framing).toHaveLength(1);
    expect(retimed.framing[0].id).toBe("shot-3");
    expect(retimed.framing[0].startSec).toBe(0);
    expect(retimed.framing[0].endSec).toBe(20);
    expect(validateRenderPlan(retimed)).toEqual({ ok: true, errors: [] });
  });

  it("décale aussi les illustrations et les images clés", () => {
    const retimed = retimeRenderPlan(framed, 20, 40);
    expect(retimed.overlays[0].startSec).toBe(5);
    expect(retimed.overlays[0].endSec).toBe(10);
    expect(retimed.zoomKeyframes.every((kf) => kf.tSec >= 0 && kf.tSec <= 20)).toBe(true);
  });

  it("ne garde rien de ce qui se trouvait avant le nouveau début", () => {
    const retimed = retimeRenderPlan(framed, 20, 40);
    expect(retimed.framing.some((shot) => shot.id === "shot-1")).toBe(false);
    expect(retimed.framing.some((shot) => shot.id === "shot-2")).toBe(false);
  });

  it("couvre le clip de bout en bout après un décalage partiel", () => {
    const retimed = retimeRenderPlan(framed, 50, 10);
    expect(retimed.framing[0].startSec).toBe(0);
    for (let i = 1; i < retimed.framing.length; i++) {
      expect(retimed.framing[i].startSec).toBeCloseTo(retimed.framing[i - 1].endSec, 6);
    }
    expect(retimed.framing[retimed.framing.length - 1].endSec).toBe(50);
    expect(validateRenderPlan(retimed).ok).toBe(true);
  });

  it("se comporte comme avant quand le début ne bouge pas", () => {
    expect(retimeRenderPlan(framed, 40, 0)).toEqual(retimeRenderPlan(framed, 40));
  });

  it("ignore un décalage non fini plutôt que de produire des temps NaN", () => {
    const retimed = retimeRenderPlan(framed, 40, Number.NaN);
    expect(retimed.framing.every((shot) => Number.isFinite(shot.startSec))).toBe(true);
    expect(validateRenderPlan(retimed).ok).toBe(true);
  });
});
