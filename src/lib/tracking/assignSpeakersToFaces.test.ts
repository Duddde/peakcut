import { describe, expect, it } from "vitest";
import { assignSpeakersToFaces } from "./assignSpeakersToFaces";
import type { SpeechTurn } from "./speechTurns";
import type { DetectedBoundingBox, SubjectTrack } from "./types";

/**
 * What matters in these tests is as much what the matching refuses to
 * answer as what it answers: a wrong voice-to-face match frames every
 * clip on the person who is listening, which is worse than not following
 * the speaker at all.
 */

function box(tSec: number, x: number, activity?: number): DetectedBoundingBox {
  return {
    tSec,
    x,
    y: 0.3,
    width: 0.1,
    height: 0.18,
    score: 0.8,
    ...(activity === undefined ? {} : { activity }),
  };
}

/** A subject whose mouth moves by `activity` at every second of `seconds`. */
function subject(id: string, x: number, seconds: number[], activityAt: (tSec: number) => number | undefined): SubjectTrack {
  return { id, boxes: seconds.map((tSec) => box(tSec, x, activityAt(tSec))) };
}

const TURNS: SpeechTurn[] = [
  { speaker: "A", startSec: 0, endSec: 5 },
  { speaker: "B", startSec: 6, endSec: 11 },
];

/** Left face talks during A's turn, right face during B's. */
const LEFT = subject("s1", 0.15, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.06 : 0.004));
const RIGHT = subject("s2", 0.75, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.003 : 0.07));

describe("assignSpeakersToFaces", () => {
  it("associe chaque voix au visage qui bouge pendant ses prises de parole", () => {
    const result = assignSpeakersToFaces([LEFT, RIGHT], TURNS);
    expect(result.bySpeaker).toEqual({ A: "s1", B: "s2" });
    expect(result.reasons).toEqual([]);
  });

  it("ne tranche pas quand un seul visage est détecté", () => {
    const result = assignSpeakersToFaces([LEFT], TURNS);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /un seul visage/i.test(r))).toBe(true);
  });

  it("ne tranche pas quand une seule voix est identifiée", () => {
    const result = assignSpeakersToFaces([LEFT, RIGHT], [{ speaker: "A", startSec: 0, endSec: 11 }]);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /une seule voix/i.test(r))).toBe(true);
  });

  it("ne tranche pas quand le moteur ne mesure pas l'activité labiale", () => {
    const unmeasured = [
      subject("s1", 0.15, [0, 1, 2, 3, 4, 5], () => undefined),
      subject("s2", 0.75, [0, 1, 2, 3, 4, 5], () => undefined),
    ];
    const result = assignSpeakersToFaces(unmeasured, TURNS);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /activité labiale/i.test(r))).toBe(true);
  });

  it("ne tranche pas entre deux visages qui bougent autant", () => {
    const sameMotion = [
      subject("s1", 0.15, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], () => 0.05),
      subject("s2", 0.75, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], () => 0.048),
    ];
    const result = assignSpeakersToFaces(sameMotion, TURNS);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /un pari/i.test(r))).toBe(true);
  });

  it("ne tranche pas quand aucun visage ne bouge assez pour parler", () => {
    const still = [
      subject("s1", 0.15, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.0009 : 0.0001)),
      subject("s2", 0.75, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.0001 : 0.0009)),
    ];
    const result = assignSpeakersToFaces(still, TURNS);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /ne bouge assez/i.test(r))).toBe(true);
  });

  it("exige assez d'images mesurées pendant les prises de parole", () => {
    const sparse = [
      subject("s1", 0.15, [0, 9], (t) => (t === 0 ? 0.06 : 0.002)),
      subject("s2", 0.75, [0, 9], (t) => (t === 0 ? 0.002 : 0.06)),
    ];
    const result = assignSpeakersToFaces(sparse, TURNS);
    expect(result.bySpeaker).toEqual({});
    expect(result.reasons.some((r) => /pas assez d'images/i.test(r))).toBe(true);
  });

  it("ne donne jamais le même visage à deux voix", () => {
    // Both voices correlate best with the left face; only the clearer
    // match keeps it, and the other is left unresolved rather than being
    // pushed onto the remaining face by elimination.
    const bothLeft: SubjectTrack[] = [
      subject("s1", 0.15, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.09 : 0.05)),
      subject("s2", 0.75, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], () => 0.002),
    ];
    const result = assignSpeakersToFaces(bothLeft, TURNS);
    expect(Object.values(result.bySpeaker)).toEqual(["s1"]);
    expect(Object.keys(result.bySpeaker)).toEqual(["A"]);
    expect(result.reasons.some((r) => /déjà attribué/i.test(r))).toBe(true);
  });

  it("ne compte que les images situées dans les tours de l'intervenant", () => {
    // The right face moves a great deal, but only while A is talking —
    // during B's own turns it is still, so it cannot be B.
    const tracks = [
      subject("s1", 0.15, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.02 : 0.08)),
      subject("s2", 0.75, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], (t) => (t <= 5 ? 0.09 : 0.004)),
    ];
    const result = assignSpeakersToFaces(tracks, TURNS);
    expect(result.bySpeaker).toEqual({ A: "s2", B: "s1" });
  });
});
