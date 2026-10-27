import { describe, expect, it } from "vitest";
import { buildFaceFraming, type BuildFaceFramingInput } from "./buildFaceFraming";
import type { DetectedBoundingBox } from "./types";
import { MIN_FRAMING_SHOT_DURATION_SEC } from "@/lib/effects/types";

/**
 * A 1920×1080 source framed in 9:16: the crop window is 0.316 of the
 * width, so a face at cx is framed by a crop starting near cx - 0.158.
 */
const SOURCE = { sourceWidth: 1920, sourceHeight: 1080, targetAspect: 9 / 16 };

function face(tSec: number, cx: number, activity?: number, height = 0.3): DetectedBoundingBox {
  return {
    tSec,
    x: cx - 0.08,
    y: 0.25,
    width: 0.16,
    height,
    score: 0.9,
    ...(activity === undefined ? {} : { activity }),
  };
}

function input(overrides: Partial<BuildFaceFramingInput>): BuildFaceFramingInput {
  return { detections: [], cuts: [], turns: [], clipStartSec: 0, clipEndSec: 10, ...SOURCE, ...overrides };
}

/** Center of the crop in force at a clip-relative time. */
function frameCenterAt(result: ReturnType<typeof buildFaceFraming>, tSec: number): number {
  const shot = result.shots.find((s) => tSec >= s.startSec && tSec < s.endSec);
  if (!shot) throw new Error(`aucun plan à ${tSec}s`);
  return shot.rect.x + shot.rect.width / 2;
}

describe("buildFaceFraming", () => {
  it("changes framing exactly on the camera cuts of alternating close-ups", () => {
    const result = buildFaceFraming(
      input({
        cuts: [2.5, 5.2, 7.9],
        detections: [face(0.5, 0.35), face(2.6, 0.65), face(5.3, 0.35), face(8, 0.65)],
      })
    );

    expect(result.shots.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 2.5],
      [2.5, 5.2],
      [5.2, 7.9],
      [7.9, 10],
    ]);
    expect(frameCenterAt(result, 1)).toBeCloseTo(0.35, 2);
    expect(frameCenterAt(result, 3)).toBeCloseTo(0.65, 2);
    expect(result.shots.every((s) => s.transitionSec === 0)).toBe(true);
  });

  it("in a wide shot, frames whoever's mouth moves while they speak, and switches in the pause", () => {
    const detections: DetectedBoundingBox[] = [];
    for (let t = 0; t < 10; t++) {
      detections.push(face(t, 0.2, t < 5 ? 0.05 : 0.004), face(t, 0.8, t < 5 ? 0.004 : 0.06));
    }
    const result = buildFaceFraming(
      input({
        detections,
        turns: [
          { speaker: "A", startSec: 0, endSec: 4.6 },
          { speaker: "B", startSec: 5.4, endSec: 10 },
        ],
      })
    );

    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].endSec).toBeCloseTo(5, 6);
    expect(frameCenterAt(result, 2)).toBeLessThan(0.4);
    expect(frameCenterAt(result, 8)).toBeGreaterThan(0.6);
  });

  it("does not guess between two faces that move as much as each other: it stays on the most present one", () => {
    const detections: DetectedBoundingBox[] = [];
    for (let t = 0; t < 10; t++) detections.push(face(t, 0.2, 0.03), face(t, 0.8, 0.03));
    detections.push(face(10, 0.8, 0.03), face(10.5, 0.8, 0.03)); // seen a little more often
    const result = buildFaceFraming(input({ detections, turns: [{ speaker: "A", startSec: 0, endSec: 10 }] }));

    expect(result.shots).toEqual([]);
    expect(result.dominantCenter?.cx).toBeCloseTo(0.8, 2);
  });

  it("keeps the previous framing on a shot where no face is found", () => {
    const result = buildFaceFraming(
      input({ cuts: [4, 7], detections: [face(1, 0.3), face(7.5, 0.7)] })
    );

    expect(frameCenterAt(result, 5)).toBeCloseTo(0.3, 2);
    expect(result.notes.join(" ")).toMatch(/sans visage/);
  });

  it("ignores faces much smaller than the main one: background people and false detections", () => {
    const result = buildFaceFraming(
      input({ detections: [face(1, 0.4, 0.01, 0.4), face(1, 0.9, 0.2, 0.08), face(3, 0.4, 0.01, 0.4)] })
    );
    expect(result.shots).toEqual([]);
    expect(result.dominantCenter?.cx).toBeCloseTo(0.4, 2);
  });

  it("looks at the whole camera shot even when the clip starts in the middle of it", () => {
    // The only detection of the first shot is before the clip's start.
    const result = buildFaceFraming(
      input({ clipStartSec: 20, clipEndSec: 30, cuts: [15, 25], detections: [face(16, 0.3), face(25.1, 0.7)] })
    );
    expect(frameCenterAt(result, 0)).toBeCloseTo(0.3, 2);
    expect(frameCenterAt(result, 6)).toBeCloseTo(0.7, 2);
  });

  it("says so when there is no face at all, and leaves the crop alone", () => {
    const result = buildFaceFraming(input({ cuts: [5] }));
    expect(result.shots).toEqual([]);
    expect(result.dominantCenter).toBeNull();
    expect(result.notes.join(" ")).toMatch(/aucun visage/i);
  });

  it("merges consecutive camera shots on the same face into one shot", () => {
    const result = buildFaceFraming(input({ cuts: [3, 6], detections: [face(1, 0.3), face(4, 0.305), face(7, 0.7)] }));
    expect(result.shots.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 6],
      [6, 10],
    ]);
  });

  it("never leaves a shot shorter than the plan accepts — a refused plan would not be applied at all", () => {
    // A cut 0.03 s after the clip's start and two cuts 0.1 s apart.
    const result = buildFaceFraming(
      input({
        cuts: [0.03, 4, 4.1],
        detections: [face(-1, 0.6), face(0.5, 0.3), face(4.05, 0.7), face(5, 0.4)],
      })
    );
    expect(result.shots.length).toBeGreaterThan(1);
    for (const shot of result.shots) {
      expect(shot.endSec - shot.startSec).toBeGreaterThanOrEqual(MIN_FRAMING_SHOT_DURATION_SEC);
    }
    expect(result.shots[0].startSec).toBe(0);
    expect(result.shots[result.shots.length - 1].endSec).toBe(10);
  });
});
