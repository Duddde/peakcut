import { describe, expect, it } from "vitest";
import { buildSpeakerFraming } from "./buildSpeakerFraming";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import { MAX_FRAMING_SHOTS_PER_PLAN, MIN_FRAMING_SHOT_DURATION_SEC } from "@/lib/effects/types";
import type { SpeechTurn } from "./speechTurns";
import type { DetectedBoundingBox, SubjectTrack } from "./types";

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const TARGET_ASPECT = 1080 / 1920;

function boxesAt(x: number, from: number, to: number): DetectedBoundingBox[] {
  const boxes: DetectedBoundingBox[] = [];
  for (let tSec = from; tSec <= to; tSec++) {
    boxes.push({ tSec, x, y: 0.3, width: 0.12, height: 0.2, score: 0.8, activity: 0.05 });
  }
  return boxes;
}

const LEFT: SubjectTrack = { id: "s1", boxes: boxesAt(0.1, 0, 120) };
const RIGHT: SubjectTrack = { id: "s2", boxes: boxesAt(0.72, 0, 120) };
const TRACKS = [LEFT, RIGHT];
const ASSIGNMENT = { bySpeaker: { A: "s1", B: "s2" }, reasons: [] };

function build(turns: SpeechTurn[], overrides: Partial<Parameters<typeof buildSpeakerFraming>[0]> = {}) {
  return buildSpeakerFraming({
    tracks: TRACKS,
    turns,
    assignment: ASSIGNMENT,
    clipStartSec: 30,
    clipEndSec: 90,
    targetAspect: TARGET_ASPECT,
    sourceWidth: SOURCE_WIDTH,
    sourceHeight: SOURCE_HEIGHT,
    ...overrides,
  });
}

describe("buildSpeakerFraming", () => {
  it("fait basculer le cadrage d'un intervenant à l'autre", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 45 },
      { speaker: "B", startSec: 46, endSec: 60 },
      { speaker: "A", startSec: 61, endSec: 90 },
    ]);

    expect(result.shots).toHaveLength(3);
    expect(result.shots.map((s) => s.label)).toEqual(["Intervenant A", "Intervenant B", "Intervenant A"]);
    // The left face is left of the right face in the source, so its crop
    // window starts further left.
    expect(result.shots[0].rect.x).toBeLessThan(result.shots[1].rect.x);
    expect(result.shots[2].rect.x).toBeCloseTo(result.shots[0].rect.x, 6);
  });

  it("donne des temps relatifs au clip, pas à la source", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 45 },
      { speaker: "B", startSec: 45, endSec: 90 },
    ]);

    expect(result.shots[0].startSec).toBe(0);
    expect(result.shots[result.shots.length - 1].endSec).toBe(60);
  });

  it("couvre le clip de bout en bout, sans trou", () => {
    const result = build([
      { speaker: "A", startSec: 35, endSec: 44 },
      { speaker: "B", startSec: 50, endSec: 70 },
      { speaker: "A", startSec: 80, endSec: 85 },
    ]);

    expect(result.shots[0].startSec).toBe(0);
    for (let i = 1; i < result.shots.length; i++) {
      expect(result.shots[i].startSec).toBeCloseTo(result.shots[i - 1].endSec, 6);
    }
    expect(result.shots[result.shots.length - 1].endSec).toBe(60);
  });

  it("coupe au milieu du silence entre deux intervenants", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 40 },
      { speaker: "B", startSec: 50, endSec: 90 },
    ]);

    // A stops at clip second 10, B starts at 20: the cut belongs at 15,
    // in the pause, not on the first syllable of the answer.
    expect(result.shots[0].endSec).toBeCloseTo(15, 6);
    expect(result.shots[1].startSec).toBeCloseTo(15, 6);
  });

  it("absorbe une interjection trop courte au lieu d'en faire un plan", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 50 },
      // Two words from the other person, in the middle of a sentence.
      { speaker: "B", startSec: 50.1, endSec: 50.5 },
      { speaker: "A", startSec: 50.6, endSec: 90 },
    ]);

    // The interjection is absorbed, which leaves one subject for the whole
    // clip — and one framing is what a static crop already does, so
    // nothing is claimed at all.
    expect(result.shots).toEqual([]);
    expect(result.notes.some((n) => /un seul intervenant/i.test(n))).toBe(true);
  });

  it("garde tous les plans au-dessus de la durée minimale du modèle", () => {
    const turns: SpeechTurn[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push({ speaker: i % 2 === 0 ? "A" : "B", startSec: 30 + i * 3, endSec: 30 + i * 3 + 2.5 });
    }
    const result = build(turns);

    expect(result.shots.length).toBeGreaterThan(1);
    for (const shot of result.shots) {
      expect(shot.endSec - shot.startSec).toBeGreaterThanOrEqual(MIN_FRAMING_SHOT_DURATION_SEC);
    }
  });

  it("ne dépasse jamais le nombre de plans que le modèle autorise, et le dit", () => {
    const turns: SpeechTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ speaker: i % 2 === 0 ? "A" : "B", startSec: 30 + i * 1.5, endSec: 30 + i * 1.5 + 1.4 });
    }
    const result = build(turns);

    expect(result.shots.length).toBeLessThanOrEqual(MAX_FRAMING_SHOTS_PER_PLAN);
    expect(result.notes.some((n) => /plans de cadrage sont conservés/i.test(n))).toBe(true);
  });

  it("n'ajoute aucun plan quand un seul intervenant parle dans le clip", () => {
    const result = build([{ speaker: "A", startSec: 30, endSec: 90 }]);
    expect(result.shots).toEqual([]);
    expect(result.notes.some((n) => /cadrage statique le suit déjà/i.test(n))).toBe(true);
  });

  it("n'ajoute aucun plan quand aucune voix n'est rattachée à un visage", () => {
    const result = build(
      [
        { speaker: "A", startSec: 30, endSec: 60 },
        { speaker: "B", startSec: 60, endSec: 90 },
      ],
      { assignment: { bySpeaker: {}, reasons: ["peu importe"] } }
    );
    expect(result.shots).toEqual([]);
    expect(result.notes.some((n) => /visage identifié/i.test(n))).toBe(true);
  });

  it("ignore les prises de parole hors du clip", () => {
    const result = build([
      { speaker: "A", startSec: 0, endSec: 20 },
      { speaker: "B", startSec: 100, endSec: 120 },
      { speaker: "A", startSec: 30, endSec: 60 },
      { speaker: "B", startSec: 60, endSec: 90 },
    ]);

    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].startSec).toBe(0);
    expect(result.shots[1].endSec).toBe(60);
  });

  it("coupe franchement : aucune transition n'est inventée", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 60 },
      { speaker: "B", startSec: 60, endSec: 90 },
    ]);
    expect(result.shots.every((shot) => shot.transitionSec === 0)).toBe(true);
    expect(result.shots.every((shot) => shot.source === "speaker")).toBe(true);
  });

  it("garde une fenêtre de cadrage identique d'un plan à l'autre, dans le cadre source", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 60 },
      { speaker: "B", startSec: 60, endSec: 90 },
    ]);

    for (const shot of result.shots) {
      expect(shot.rect.width).toBeCloseTo(result.shots[0].rect.width, 6);
      expect(shot.rect.height).toBeCloseTo(result.shots[0].rect.height, 6);
      expect(shot.rect.x).toBeGreaterThanOrEqual(0);
      expect(shot.rect.x + shot.rect.width).toBeLessThanOrEqual(1);
      expect(shot.rect.y).toBeGreaterThanOrEqual(0);
      expect(shot.rect.y + shot.rect.height).toBeLessThanOrEqual(1);
    }
  });

  it("produit un plan de rendu que le validateur accepte", () => {
    const result = build([
      { speaker: "A", startSec: 30, endSec: 45 },
      { speaker: "B", startSec: 46, endSec: 70 },
      { speaker: "A", startSec: 71, endSec: 90 },
    ]);

    const plan = buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 60 });
    const check = validateRenderPlan({ ...plan, framing: result.shots });
    expect(check).toEqual({ ok: true, errors: [] });
  });

  it("ne rend rien pour un clip de durée nulle", () => {
    const result = build([{ speaker: "A", startSec: 30, endSec: 30 }], { clipEndSec: 30 });
    expect(result.shots).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("nettoie l'étiquette d'intervenant au lieu de la recopier telle quelle", () => {
    const result = build(
      [
        { speaker: "A\u0007\u0007", startSec: 30, endSec: 60 },
        { speaker: "B", startSec: 60, endSec: 90 },
      ],
      { assignment: { bySpeaker: { "A\u0007\u0007": "s1", B: "s2" }, reasons: [] } }
    );

    expect(result.shots[0].label).toBe("Intervenant A");
  });
});
