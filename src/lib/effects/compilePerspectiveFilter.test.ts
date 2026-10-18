import { describe, expect, it } from "vitest";
import { compilePerspectiveFilter } from "./compilePerspectiveFilter";
import { validateFilterGraph } from "./validateFilterGraph";
import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  PERSPECTIVE_EVAL_FPS,
  PERSPECTIVE_INSET_MAX,
  type PerspectiveMove,
} from "./types";

function move(partial: Partial<PerspectiveMove> = {}): PerspectiveMove {
  return {
    id: "m1",
    startSec: 1,
    endSec: 2,
    direction: "left",
    profile: "swing",
    amount: 1,
    ...partial,
  };
}

/** The value of one corner expression, evaluated the way ffmpeg would. */
function evaluateCorner(fragment: string, corner: string, onFrame: number, W = 1080, H = 1920): number {
  const matched = new RegExp(`${corner}='([^']*)'`).exec(fragment);
  if (!matched) throw new Error(`Coin "${corner}" absent du fragment : ${fragment}`);
  const expression = matched[1]
    .replace(/\bon\b/g, String(onFrame))
    .replace(/\bW\b/g, String(W))
    .replace(/\bH\b/g, String(H))
    .replace(/\bPI\b/g, String(Math.PI))
    .replace(/\bsin\(/g, "Math.sin(")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\bgte\(([^,]+),([^)]+)\)/g, "(($1)>=($2)?1:0)")
    .replace(/\blt\(([^,]+),([^)]+)\)/g, "(($1)<($2)?1:0)")
    .replace(/\bif\(/g, "__if(");
  const __if = (cond: number, a: number, b: number) => (cond ? a : b);
  return Function("__if", `"use strict"; return (${expression});`)(__if);
}

describe("compilePerspectiveFilter", () => {
  it("compiles nothing at all when the clip has no 3D move", () => {
    const compiled = compilePerspectiveFilter({ moves: [] });
    expect(compiled.filterFragment).toBeNull();
    expect(compiled.movesApplied).toBe(0);
    expect(compiled.notes).toEqual([]);
  });

  it("pins the frame rate it reads its own clock from", () => {
    const compiled = compilePerspectiveFilter({ moves: [move()] });
    expect(compiled.filterFragment).toContain(`fps=${PERSPECTIVE_EVAL_FPS},perspective=`);
    expect(compiled.filterFragment).toContain("eval=frame");
    expect(compiled.filterFragment).toContain("sense=source");
  });

  it("keeps the quadrilateral inside the frame, so no pixel is invented", () => {
    const fragment = compilePerspectiveFilter({ moves: [move({ amount: 1 })] }).filterFragment!;
    const peakFrame = Math.round(1.5 * PERSPECTIVE_EVAL_FPS);
    for (const corner of ["x0", "x1", "x2", "x3"]) {
      const value = evaluateCorner(fragment, corner, peakFrame);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1080);
    }
    for (const corner of ["y0", "y1", "y2", "y3"]) {
      const value = evaluateCorner(fragment, corner, peakFrame);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1920);
    }
  });

  it("is the identity outside the move's window", () => {
    const fragment = compilePerspectiveFilter({ moves: [move({ startSec: 1, endSec: 2 })] }).filterFragment!;
    for (const onFrame of [0, 10, 29, 61, 200]) {
      expect(evaluateCorner(fragment, "y0", onFrame)).toBe(0);
      expect(evaluateCorner(fragment, "y1", onFrame)).toBe(0);
      expect(evaluateCorner(fragment, "y2", onFrame)).toBe(1920);
      expect(evaluateCorner(fragment, "y3", onFrame)).toBe(1920);
    }
  });

  it("pulls in the left edge and leaves the right one whole for direction \"left\"", () => {
    const fragment = compilePerspectiveFilter({ moves: [move({ direction: "left", amount: 1 })] })
      .filterFragment!;
    const peakFrame = Math.round(1.5 * PERSPECTIVE_EVAL_FPS);

    // The left edge is (y0, y2): it closes in by the full inset.
    expect(evaluateCorner(fragment, "y0", peakFrame)).toBeCloseTo((1920 * PERSPECTIVE_INSET_MAX) / 2, 2);
    expect(evaluateCorner(fragment, "y2", peakFrame)).toBeCloseTo(
      1920 * (1 - PERSPECTIVE_INSET_MAX / 2),
      2
    );
    // The right edge is untouched, which is what makes it read as the far one.
    expect(evaluateCorner(fragment, "y1", peakFrame)).toBe(0);
    expect(evaluateCorner(fragment, "y3", peakFrame)).toBe(1920);
  });

  it("mirrors the inset for direction \"right\"", () => {
    const fragment = compilePerspectiveFilter({ moves: [move({ direction: "right", amount: 1 })] })
      .filterFragment!;
    const peakFrame = Math.round(1.5 * PERSPECTIVE_EVAL_FPS);
    expect(evaluateCorner(fragment, "y0", peakFrame)).toBe(0);
    expect(evaluateCorner(fragment, "y2", peakFrame)).toBe(1920);
    expect(evaluateCorner(fragment, "y1", peakFrame)).toBeCloseTo((1920 * PERSPECTIVE_INSET_MAX) / 2, 2);
  });

  it("moves the x corners, not the y ones, for a vertical tilt", () => {
    const fragment = compilePerspectiveFilter({ moves: [move({ direction: "up", amount: 1 })] })
      .filterFragment!;
    const peakFrame = Math.round(1.5 * PERSPECTIVE_EVAL_FPS);
    expect(evaluateCorner(fragment, "x0", peakFrame)).toBeCloseTo((1080 * PERSPECTIVE_INSET_MAX) / 2, 2);
    expect(evaluateCorner(fragment, "x1", peakFrame)).toBeCloseTo(
      1080 * (1 - PERSPECTIVE_INSET_MAX / 2),
      2
    );
    expect(evaluateCorner(fragment, "x2", peakFrame)).toBe(0);
    // A horizontal-only move leaves the y corners as bare constants.
    expect(fragment).toContain("y0='0'");
    expect(fragment).toContain("y2='H'");
  });

  it("scales the tilt with the move's amount", () => {
    const peakFrame = Math.round(1.5 * PERSPECTIVE_EVAL_FPS);
    const strong = compilePerspectiveFilter({ moves: [move({ amount: 1 })] }).filterFragment!;
    const gentle = compilePerspectiveFilter({ moves: [move({ amount: 0.25 })] }).filterFragment!;
    expect(evaluateCorner(gentle, "y0", peakFrame)).toBeGreaterThan(0);
    expect(evaluateCorner(gentle, "y0", peakFrame)).toBeLessThan(
      evaluateCorner(strong, "y0", peakFrame)
    );
  });

  it("lands flat at the end of a \"settle\" and starts flat at the start of a \"lift\"", () => {
    const settle = compilePerspectiveFilter({
      moves: [move({ profile: "settle", startSec: 0, endSec: 2 })],
    }).filterFragment!;
    expect(evaluateCorner(settle, "y0", 0)).toBeCloseTo((1920 * PERSPECTIVE_INSET_MAX) / 2, 2);
    expect(evaluateCorner(settle, "y0", 59)).toBeLessThan(2);

    const lift = compilePerspectiveFilter({
      moves: [move({ profile: "lift", startSec: 0, endSec: 2 })],
    }).filterFragment!;
    expect(evaluateCorner(lift, "y0", 0)).toBe(0);
    expect(evaluateCorner(lift, "y0", 59)).toBeGreaterThan((1920 * PERSPECTIVE_INSET_MAX) / 2 - 20);
  });

  it("combines a horizontal and a vertical move running at the same time", () => {
    const compiled = compilePerspectiveFilter({
      moves: [
        move({ id: "h", direction: "left", startSec: 0, endSec: 2 }),
        move({ id: "v", direction: "up", startSec: 0, endSec: 2 }),
      ],
    });
    expect(compiled.movesApplied).toBe(2);
    const peakFrame = 30;
    expect(evaluateCorner(compiled.filterFragment!, "y0", peakFrame)).toBeGreaterThan(0);
    expect(evaluateCorner(compiled.filterFragment!, "x0", peakFrame)).toBeGreaterThan(0);
  });

  it("drops the whole list rather than half of it when one move is impossible", () => {
    const compiled = compilePerspectiveFilter({
      moves: [move({ id: "ok", startSec: 0, endSec: 1 }), move({ id: "bad", startSec: 5, endSec: 4 })],
    });
    expect(compiled.filterFragment).toBeNull();
    expect(compiled.movesApplied).toBe(0);
    expect(compiled.notes.join(" ")).toMatch(/Effets 3D ignorés/);
  });

  it("refuses two moves fighting over the same axis", () => {
    const compiled = compilePerspectiveFilter({
      moves: [
        move({ id: "a", direction: "left", startSec: 0, endSec: 2 }),
        move({ id: "b", direction: "right", startSec: 1, endSec: 3 }),
      ],
    });
    expect(compiled.filterFragment).toBeNull();
    expect(compiled.notes.join(" ")).toMatch(/chevauchent sur le même axe/);
  });

  it("refuses an amount outside its bounds rather than clamping it silently", () => {
    const compiled = compilePerspectiveFilter({ moves: [move({ amount: 4 })] });
    expect(compiled.filterFragment).toBeNull();
    expect(compiled.notes.join(" ")).toMatch(/intensité hors bornes/);
  });

  it("refuses more moves than a filtergraph can carry", () => {
    const moves = Array.from({ length: MAX_PERSPECTIVE_MOVES_PER_PLAN + 1 }, (_, i) =>
      move({ id: `m${i}`, startSec: i * 2, endSec: i * 2 + 1 })
    );
    const compiled = compilePerspectiveFilter({ moves });
    expect(compiled.filterFragment).toBeNull();
    expect(compiled.notes.join(" ")).toMatch(/maximum/);
  });

  it("stays within what the independent filtergraph validator accepts, at the cap", () => {
    // The worst realistic case: the cap reached, both axes busy, every
    // profile represented. If this ever fails, the cap is too high.
    const profiles = ["swing", "settle", "lift"] as const;
    const directions = ["left", "right", "up", "down"] as const;
    const moves = Array.from({ length: MAX_PERSPECTIVE_MOVES_PER_PLAN }, (_, i) =>
      move({
        id: `m${i}`,
        startSec: i * 3,
        endSec: i * 3 + 2.5,
        profile: profiles[i % profiles.length],
        direction: directions[i % directions.length],
      })
    );
    const compiled = compilePerspectiveFilter({ moves });
    expect(compiled.movesApplied).toBe(MAX_PERSPECTIVE_MOVES_PER_PLAN);
    expect(validateFilterGraph(compiled.filterFragment!)).toEqual({ ok: true, errors: [] });
  });
});
