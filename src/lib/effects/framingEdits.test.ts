import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import {
  framingSubjects,
  moveFramingBoundary,
  removeFramingShot,
  retargetFramingShot,
  setFramingTransition,
} from "./framingEdits";
import {
  FRAMING_TRANSITION_SEC_MAX,
  MIN_FRAMING_SHOT_DURATION_SEC,
  type FramingShot,
} from "./types";

const LEFT_RECT = { x: 0.05, y: 0, width: 0.5625, height: 1 };
const RIGHT_RECT = { x: 0.39, y: 0, width: 0.5625, height: 1 };

function shot(id: string, startSec: number, endSec: number, rect = LEFT_RECT, label = "Intervenant A"): FramingShot {
  return { id, startSec, endSec, rect, transitionSec: 0, source: "speaker", label };
}

const SHOTS: FramingShot[] = [
  shot("shot-1", 0, 20),
  shot("shot-2", 20, 40, RIGHT_RECT, "Intervenant B"),
  shot("shot-3", 40, 60),
];

/** Every edit must leave a plan the server would accept on save. */
function expectValid(shots: FramingShot[]) {
  const plan = buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 60 });
  expect(validateRenderPlan({ ...plan, framing: shots })).toEqual({ ok: true, errors: [] });
}

function expectContiguous(shots: FramingShot[], endSec: number) {
  if (shots.length === 0) return;
  expect(shots[0].startSec).toBe(0);
  for (let i = 1; i < shots.length; i++) {
    expect(shots[i].startSec).toBeCloseTo(shots[i - 1].endSec, 6);
  }
  expect(shots[shots.length - 1].endSec).toBe(endSec);
}

describe("framingSubjects", () => {
  it("liste les sujets distincts dans leur ordre d'apparition", () => {
    expect(framingSubjects(SHOTS).map((s) => s.label)).toEqual(["Intervenant A", "Intervenant B"]);
  });

  it("compte les plans de chaque sujet", () => {
    expect(framingSubjects(SHOTS).map((s) => s.shotCount)).toEqual([2, 1]);
  });

  it("ne propose pas deux fois la même personne quand ses fenêtres diffèrent d'un pixel", () => {
    const drifted = [
      shot("shot-1", 0, 20),
      shot("shot-2", 20, 40, { ...LEFT_RECT, x: 0.0501 }),
    ];
    expect(framingSubjects(drifted)).toHaveLength(1);
  });

  it("nomme un sujet sans libellé plutôt que de le taire", () => {
    const unnamed = [{ ...shot("shot-1", 0, 20), label: null }];
    expect(framingSubjects(unnamed)[0].label).toBe("Sujet sans nom");
  });
});

describe("moveFramingBoundary", () => {
  it("déplace la coupe entre deux plans et garde le clip couvert", () => {
    const moved = moveFramingBoundary(SHOTS, 0, 12);
    expect(moved[0].endSec).toBe(12);
    expect(moved[1].startSec).toBe(12);
    expectContiguous(moved, 60);
    expectValid(moved);
  });

  it("s'arrête à la limite au lieu d'écraser le plan voisin", () => {
    const tooEarly = moveFramingBoundary(SHOTS, 0, -50);
    expect(tooEarly[0].endSec).toBeGreaterThanOrEqual(MIN_FRAMING_SHOT_DURATION_SEC);
    expect(tooEarly[0].endSec).toBeLessThan(MIN_FRAMING_SHOT_DURATION_SEC + 0.01);
    const tooLate = moveFramingBoundary(SHOTS, 0, 500);
    expect(tooLate[1].endSec - tooLate[1].startSec).toBeGreaterThanOrEqual(MIN_FRAMING_SHOT_DURATION_SEC);
    expectValid(tooEarly);
    expectValid(tooLate);
  });

  it("raccourcit le panoramique avec le plan qu'il ouvre", () => {
    const withPan = [SHOTS[0], { ...SHOTS[1], transitionSec: 1 }, SHOTS[2]];
    const moved = moveFramingBoundary(withPan, 0, 39.5);
    expect(moved[1].transitionSec).toBeLessThanOrEqual(moved[1].endSec - moved[1].startSec);
    expectValid(moved);
  });

  it("ignore un index qui ne désigne pas une coupe", () => {
    expect(moveFramingBoundary(SHOTS, 2, 50)).toBe(SHOTS);
    expect(moveFramingBoundary(SHOTS, -1, 50)).toBe(SHOTS);
  });
});

describe("retargetFramingShot", () => {
  it("recadre un plan sur un autre sujet du clip", () => {
    const subject = framingSubjects(SHOTS)[1];
    const retargeted = retargetFramingShot(SHOTS, "shot-1", subject);
    expect(retargeted[0].rect).toEqual(RIGHT_RECT);
    expect(retargeted[0].label).toBe("Intervenant B");
    expectValid(retargeted);
  });

  it("marque le plan comme venant de l'utilisateur, pas de la détection", () => {
    const retargeted = retargetFramingShot(SHOTS, "shot-1", framingSubjects(SHOTS)[1]);
    expect(retargeted[0].source).toBe("manual");
    expect(retargeted[1].source).toBe("speaker");
  });
});

describe("setFramingTransition", () => {
  it("règle le panoramique d'entrée d'un plan", () => {
    const panned = setFramingTransition(SHOTS, "shot-2", 0.4);
    expect(panned[1].transitionSec).toBe(0.4);
    expectValid(panned);
  });

  it("borne le panoramique au maximum du modèle", () => {
    const panned = setFramingTransition(SHOTS, "shot-2", 99);
    expect(panned[1].transitionSec).toBe(FRAMING_TRANSITION_SEC_MAX);
    expectValid(panned);
  });

  it("ne laisse jamais le panoramique dépasser la durée du plan", () => {
    const short = [shot("shot-1", 0, 59.5), shot("shot-2", 59.5, 60, RIGHT_RECT, "Intervenant B")];
    const panned = setFramingTransition(short, "shot-2", 1);
    expect(panned[1].transitionSec).toBeLessThanOrEqual(0.5);
    expectValid(panned);
  });

  it("refuse une valeur négative en la ramenant à une coupe franche", () => {
    expect(setFramingTransition(SHOTS, "shot-2", -1)[1].transitionSec).toBe(0);
  });
});

describe("removeFramingShot", () => {
  it("donne le temps du plan supprimé à son voisin précédent", () => {
    const removed = removeFramingShot(SHOTS, "shot-2");
    expect(removed.map((s) => s.id)).toEqual(["shot-1", "shot-3"]);
    expect(removed[0].endSec).toBe(40);
    expectContiguous(removed, 60);
    expectValid(removed);
  });

  it("donne le temps du premier plan supprimé à celui qui suit", () => {
    const removed = removeFramingShot(SHOTS, "shot-1");
    expect(removed[0].id).toBe("shot-2");
    expect(removed[0].startSec).toBe(0);
    expectContiguous(removed, 60);
    expectValid(removed);
  });

  it("vide le cadrage quand il ne resterait qu'un seul plan", () => {
    // One shot is one static crop: keeping it would claim the frame
    // follows a speaker while nothing ever moves.
    expect(removeFramingShot([SHOTS[0], SHOTS[1]], "shot-2")).toEqual([]);
  });

  it("ignore un identifiant inconnu", () => {
    expect(removeFramingShot(SHOTS, "shot-42")).toBe(SHOTS);
  });

  it("ne modifie pas la liste d'origine", () => {
    const before = JSON.stringify(SHOTS);
    removeFramingShot(SHOTS, "shot-2");
    expect(JSON.stringify(SHOTS)).toBe(before);
  });
});
