import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import {
  FRAMING_LABEL_MAX_LENGTH,
  MAX_FRAMING_SHOTS_PER_PLAN,
  MAX_OVERLAYS_PER_PLAN,
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  type FramingShot,
  type Overlay,
  type PerspectiveMove,
  type RenderPlan,
} from "./types";

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

function overlay(patch: Partial<Overlay> = {}): Overlay {
  return {
    id: "ov-1",
    assetId: "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c",
    startSec: 2,
    endSec: 6,
    rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
    opacity: 0.95,
    fadeSec: 0.3,
    ...patch,
  };
}

describe("validateRenderPlan overlays", () => {
  it("accepts an illustration sitting inside the clip and inside the frame", () => {
    const plan = validPlan();
    plan.overlays = [overlay()];
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("refuses an assetId that is not an id, because the render turns it into a file lookup", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ assetId: "../../etc/passwd" })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /assetId/.test(e))).toBe(true);
  });

  it("refuses an illustration that leaves the frame", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ rect: { x: 0.8, y: 0.1, width: 0.5, height: 0.3 } })];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("refuses an illustration outside the clip's cut range", () => {
    const plan = validPlan();
    plan.cuts = [{ startSec: 0, endSec: 10 }];
    plan.overlays = [overlay({ startSec: 20, endSec: 25 })];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("refuses an illustration too brief to be seen", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ startSec: 2, endSec: 2.1, fadeSec: 0 })];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("refuses a fade longer than the illustration it fades", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ startSec: 2, endSec: 3, fadeSec: 1.4 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /fondu/i.test(e))).toBe(true);
  });

  it("refuses an opacity of zero: an invisible overlay is a mistake, not an effect", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ opacity: 0 })];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("refuses two illustrations sharing an id", () => {
    const plan = validPlan();
    plan.overlays = [overlay(), overlay()];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /double/i.test(e))).toBe(true);
  });

  it("caps how many illustrations one clip can carry", () => {
    const plan = validPlan();
    plan.overlays = Array.from({ length: MAX_OVERLAYS_PER_PLAN + 1 }, (_, i) =>
      overlay({ id: `ov-${i}` })
    );
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /illustrations/i.test(e))).toBe(true);
  });

  it("accepts two illustrations overlapping in time: stacking them is a real edit", () => {
    const plan = validPlan();
    plan.overlays = [overlay({ id: "a" }), overlay({ id: "b", startSec: 4, endSec: 8 })];
    expect(validateRenderPlan(plan).ok).toBe(true);
  });
});

function shot(overrides: Partial<FramingShot> = {}): FramingShot {
  return {
    id: "shot-1",
    startSec: 0,
    endSec: 5,
    rect: { x: 0.05, y: 0, width: 0.5625, height: 1 },
    transitionSec: 0,
    source: "speaker",
    label: "Intervenant A",
    ...overrides,
  };
}

describe("validateRenderPlan — cadrage par plans", () => {
  it("accepte un clip sans plan de cadrage : un seul cadrage statique est valide", () => {
    const plan = validPlan();
    plan.framing = [];
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("accepte deux plans contigus qui couvrent le clip", () => {
    const plan = validPlan();
    plan.framing = [shot(), shot({ id: "shot-2", startSec: 5, endSec: 10, rect: { x: 0.39, y: 0, width: 0.5625, height: 1 } })];
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("refuse deux plans qui se chevauchent : à un instant donné un seul cadrage peut gagner", () => {
    const plan = validPlan();
    plan.framing = [shot(), shot({ id: "shot-2", startSec: 4, endSec: 9 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /chevauchent/i.test(e))).toBe(true);
  });

  it("refuse un plan plus court que la durée minimale", () => {
    const plan = validPlan();
    plan.framing = [shot({ endSec: 0.1 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /trop courte/i.test(e))).toBe(true);
  });

  it("refuse un plan hors de la plage des coupes", () => {
    const plan = validPlan();
    plan.framing = [shot({ startSec: 20, endSec: 25 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /plage des coupes/i.test(e))).toBe(true);
  });

  it("refuse une fenêtre de cadrage qui sort du cadre source", () => {
    const plan = validPlan();
    plan.framing = [shot({ rect: { x: 0.6, y: 0, width: 0.5625, height: 1 } })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /cadre source/i.test(e))).toBe(true);
  });

  it("refuse une fenêtre trop petite pour rester regardable après agrandissement", () => {
    const plan = validPlan();
    plan.framing = [shot({ rect: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 } })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /trop petite/i.test(e))).toBe(true);
  });

  it("refuse une transition hors bornes", () => {
    const plan = validPlan();
    plan.framing = [shot({ transitionSec: 3 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /transition/i.test(e))).toBe(true);
  });

  it("refuse une transition plus longue que le plan qu'elle ouvre", () => {
    const plan = validPlan();
    plan.framing = [shot({ startSec: 0, endSec: 0.5, transitionSec: 0.9 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /transition|trop courte/i.test(e))).toBe(true);
  });

  it("refuse une source de plan inconnue", () => {
    const plan = validPlan();
    plan.framing = [shot({ source: "magique" as FramingShot["source"] })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /source inconnue/i.test(e))).toBe(true);
  });

  it("refuse un libellé interminable", () => {
    const plan = validPlan();
    plan.framing = [shot({ label: "x".repeat(FRAMING_LABEL_MAX_LENGTH + 1) })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /libellé/i.test(e))).toBe(true);
  });

  it("accepte un libellé absent", () => {
    const plan = validPlan();
    plan.framing = [shot({ label: null })];
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("refuse deux plans qui partagent un identifiant", () => {
    const plan = validPlan();
    plan.framing = [shot(), shot({ startSec: 5, endSec: 10 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /double/i.test(e))).toBe(true);
  });

  it("borne le nombre de plans de cadrage", () => {
    const plan = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 120 });
    plan.framing = Array.from({ length: MAX_FRAMING_SHOTS_PER_PLAN + 1 }, (_, i) =>
      shot({ id: `shot-${i}`, startSec: i * 2, endSec: i * 2 + 2 })
    );
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /trop de plans de cadrage/i.test(e))).toBe(true);
  });
});

describe("validateRenderPlan \u2014 effets 3D", () => {
  function move(partial: Partial<PerspectiveMove> = {}): PerspectiveMove {
    return {
      id: "m3d-1",
      startSec: 1,
      endSec: 3,
      direction: "left",
      profile: "swing",
      amount: 0.6,
      ...partial,
    };
  }

  it("accepte un mouvement dans les bornes", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move()];
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("refuse une direction inconnue", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ direction: "diagonale" as PerspectiveMove["direction"] })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /direction inconnue/i.test(e))).toBe(true);
  });

  it("refuse un profil inconnu", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ profile: "rebond" as PerspectiveMove["profile"] })];
    expect(validateRenderPlan(plan).ok).toBe(false);
  });

  it("refuse une intensite hors bornes", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ amount: 3 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /intensit\u00e9 hors bornes/i.test(e))).toBe(true);
  });

  it("refuse un mouvement trop court pour etre vu", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ startSec: 1, endSec: 1.05 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /trop courte/i.test(e))).toBe(true);
  });

  it("refuse un mouvement qui sort de la plage des coupes", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ startSec: 9, endSec: 15 })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /hors de la plage des coupes/i.test(e))).toBe(true);
  });

  it("refuse deux mouvements qui se chevauchent sur le meme axe", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [
      move({ id: "a", direction: "left", startSec: 1, endSec: 4 }),
      move({ id: "b", direction: "right", startSec: 3, endSec: 6 }),
    ];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /chevauchent sur le m\u00eame axe/i.test(e))).toBe(true);
  });

  it("accepte deux mouvements simultanes sur des axes differents", () => {
    // Une inclinaison horizontale et une verticale se composent en une
    // diagonale : c'est un mouvement de camera, pas un conflit.
    const plan = validPlan();
    plan.perspectiveMoves = [
      move({ id: "a", direction: "left", startSec: 1, endSec: 4 }),
      move({ id: "b", direction: "up", startSec: 1, endSec: 4 }),
    ];
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("refuse deux mouvements qui partagent un identifiant", () => {
    const plan = validPlan();
    plan.perspectiveMoves = [move({ direction: "left" }), move({ direction: "up" })];
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /double/i.test(e))).toBe(true);
  });

  it("borne le nombre de mouvements", () => {
    const plan = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 120 });
    plan.perspectiveMoves = Array.from({ length: MAX_PERSPECTIVE_MOVES_PER_PLAN + 1 }, (_, i) =>
      move({ id: `m${i}`, startSec: i * 3, endSec: i * 3 + 1 })
    );
    const result = validateRenderPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /trop d.effets 3D/i.test(e))).toBe(true);
  });
});
