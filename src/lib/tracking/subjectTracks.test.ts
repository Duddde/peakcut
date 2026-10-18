import { describe, expect, it } from "vitest";
import { groupSubjectTracks, subjectCenterIn } from "./subjectTracks";
import type { DetectedBoundingBox } from "./types";

function box(tSec: number, x: number, overrides: Partial<DetectedBoundingBox> = {}): DetectedBoundingBox {
  return { tSec, x, y: 0.3, width: 0.1, height: 0.18, score: 0.8, ...overrides };
}

describe("groupSubjectTracks", () => {
  it("ne rend aucun sujet pour une détection vide", () => {
    expect(groupSubjectTracks([])).toEqual([]);
  });

  it("sépare deux visages côte à côte en deux sujets", () => {
    const detections = [
      box(0, 0.2),
      box(0, 0.7),
      box(1, 0.21),
      box(1, 0.69),
      box(2, 0.2),
      box(2, 0.7),
    ];
    const tracks = groupSubjectTracks(detections);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].boxes.map((b) => b.x)).toEqual([0.2, 0.21, 0.2]);
    expect(tracks[1].boxes.map((b) => b.x)).toEqual([0.7, 0.69, 0.7]);
  });

  it("garde un seul sujet quand un visage se déplace lentement", () => {
    const tracks = groupSubjectTracks([box(0, 0.3), box(1, 0.33), box(2, 0.36), box(3, 0.39)]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].boxes).toHaveLength(4);
  });

  it("ouvre un nouveau sujet plutôt que de faire téléporter le premier", () => {
    const tracks = groupSubjectTracks([box(0, 0.1), box(1, 0.1), box(2, 0.85), box(3, 0.85)]);
    expect(tracks).toHaveLength(2);
  });

  it("ferme un sujet absent trop longtemps", () => {
    const tracks = groupSubjectTracks([box(0, 0.3), box(1, 0.3), box(30, 0.3), box(31, 0.3)], {
      maxGapSec: 4,
    });
    expect(tracks).toHaveLength(2);
    expect(tracks[0].boxes.map((b) => b.tSec)).toEqual([0, 1]);
    expect(tracks[1].boxes.map((b) => b.tSec)).toEqual([30, 31]);
  });

  it("écarte un sujet vu sur une seule image comme du bruit de détecteur", () => {
    const tracks = groupSubjectTracks([box(0, 0.3), box(1, 0.3), box(1, 0.9)]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].boxes.every((b) => b.x === 0.3)).toBe(true);
  });

  it("fait confiance aux identifiants du moteur quand il en fournit pour toutes les boîtes", () => {
    const detections = [
      box(0, 0.1, { trackId: "engine-a" }),
      box(0, 0.8, { trackId: "engine-b" }),
      // Same person, seen at a position the spatial heuristic would have
      // split off: the engine says otherwise, and the engine wins.
      box(1, 0.6, { trackId: "engine-a" }),
      box(1, 0.9, { trackId: "engine-b" }),
    ];
    const tracks = groupSubjectTracks(detections);
    expect(tracks.map((t) => t.id).sort()).toEqual(["engine-a", "engine-b"]);
    expect(tracks.find((t) => t.id === "engine-a")!.boxes.map((b) => b.x)).toEqual([0.1, 0.6]);
  });

  it("retombe sur la position quand le moteur n'étiquette qu'une partie des boîtes", () => {
    // A half-labelled list would split one person in two if believed.
    const tracks = groupSubjectTracks([box(0, 0.3, { trackId: "engine-a" }), box(1, 0.31), box(2, 0.3)]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("s1");
  });

  it("nomme les sujets dans leur ordre d'apparition", () => {
    const tracks = groupSubjectTracks([box(5, 0.8), box(6, 0.8), box(0, 0.2), box(1, 0.2)]);
    expect(tracks.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(tracks[0].boxes[0].tSec).toBe(0);
  });

  it("associe au plus près quand deux boîtes et deux sujets sont en jeu", () => {
    // Fed in an order where a naive first-come pass would give the left
    // box to the right subject.
    const tracks = groupSubjectTracks([
      box(0, 0.2),
      box(0, 0.26),
      box(1, 0.26),
      box(1, 0.2),
      box(2, 0.2),
      box(2, 0.26),
    ]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].boxes.map((b) => b.x)).toEqual([0.2, 0.2, 0.2]);
    expect(tracks[1].boxes.map((b) => b.x)).toEqual([0.26, 0.26, 0.26]);
  });
});

describe("subjectCenterIn", () => {
  const track = {
    id: "s1",
    boxes: [box(0, 0.2), box(1, 0.22), box(2, 0.21), box(10, 0.8)],
  };

  it("rend le centre médian des boîtes de la fenêtre", () => {
    const center = subjectCenterIn(track, 0, 2);
    // Medians of x = 0.2, 0.22, 0.21 plus half the box width.
    expect(center!.cx).toBeCloseTo(0.21 + 0.05, 5);
    expect(center!.cy).toBeCloseTo(0.3 + 0.09, 5);
  });

  it("ignore une boîte aberrante hors de la fenêtre", () => {
    const center = subjectCenterIn(track, 0, 2);
    expect(center!.cx).toBeLessThan(0.5);
  });

  it("retombe sur la boîte la plus proche quand la fenêtre n'en contient aucune", () => {
    const center = subjectCenterIn(track, 9, 9.5);
    expect(center!.cx).toBeCloseTo(0.85, 5);
  });

  it("rend null pour un sujet sans boîte", () => {
    expect(subjectCenterIn({ id: "s1", boxes: [] }, 0, 1)).toBeNull();
  });
});
