import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "./buildRenderPlan";
import { validateRenderPlan } from "./validateRenderPlan";
import {
  addPerspectiveMove,
  movePerspectiveMoveTo,
  nextPerspectiveMoveId,
  removePerspectiveMove,
  setPerspectiveAmount,
  setPerspectiveDirection,
  setPerspectiveDuration,
  setPerspectiveProfile,
} from "./perspectiveEdits";
import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  PERSPECTIVE_AMOUNT_MAX,
  PERSPECTIVE_AMOUNT_MIN,
  type PerspectiveMove,
} from "./types";

const CLIP_SEC = 60;

function move(partial: Partial<PerspectiveMove> = {}): PerspectiveMove {
  return {
    id: "m3d-1",
    startSec: 5,
    endSec: 6,
    direction: "left",
    profile: "swing",
    amount: 0.5,
    ...partial,
  };
}

/** Every edit must leave a list the server would accept on save. */
function expectValid(moves: PerspectiveMove[]) {
  const plan = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: CLIP_SEC });
  expect(validateRenderPlan({ ...plan, perspectiveMoves: moves })).toEqual({ ok: true, errors: [] });
}

describe("addPerspectiveMove", () => {
  it("adds a move and keeps the list in chronological order", () => {
    const moves = addPerspectiveMove(
      [move({ id: "a", startSec: 20, endSec: 21 })],
      { id: "b", startSec: 2, endSec: 3, direction: "up", profile: "settle", amount: 0.8 },
      CLIP_SEC
    );
    expect(moves.map((m) => m.id)).toEqual(["b", "a"]);
    expectValid(moves);
  });

  it("refuses a move on an axis already busy at that moment", () => {
    const existing = [move({ id: "a", direction: "left", startSec: 5, endSec: 8 })];
    const moves = addPerspectiveMove(
      existing,
      { id: "b", startSec: 7, endSec: 9, direction: "right", profile: "swing", amount: 0.5 },
      CLIP_SEC
    );
    expect(moves).toBe(existing);
  });

  it("accepts a simultaneous move on the other axis, which composes into a diagonal", () => {
    const moves = addPerspectiveMove(
      [move({ id: "a", direction: "left", startSec: 5, endSec: 8 })],
      { id: "b", startSec: 5, endSec: 8, direction: "down", profile: "swing", amount: 0.5 },
      CLIP_SEC
    );
    expect(moves).toHaveLength(2);
    expectValid(moves);
  });

  it("clamps a preset's window into a clip shorter than the preset", () => {
    const moves = addPerspectiveMove(
      [],
      { id: "a", startSec: 0, endSec: 5, direction: "left", profile: "settle", amount: 0.8 },
      1.2
    );
    expect(moves).toHaveLength(1);
    expect(moves[0].endSec).toBeLessThanOrEqual(1.2);
    const plan = buildRenderPlan("subtle-punch", { segmentId: "s", segmentDurationSec: 1.2 });
    expect(validateRenderPlan({ ...plan, perspectiveMoves: moves }).ok).toBe(true);
  });

  it("refuses to add anything to a clip too short to hold a move", () => {
    const moves = addPerspectiveMove(
      [],
      { id: "a", startSec: 0, endSec: 1, direction: "left", profile: "swing", amount: 0.5 },
      MIN_PERSPECTIVE_MOVE_DURATION_SEC / 2
    );
    expect(moves).toEqual([]);
  });

  it("stops at the cap rather than building a filtergraph nobody can render", () => {
    let moves: PerspectiveMove[] = [];
    for (let i = 0; i < MAX_PERSPECTIVE_MOVES_PER_PLAN + 3; i++) {
      moves = addPerspectiveMove(
        moves,
        {
          id: `m${i}`,
          startSec: i * 2,
          endSec: i * 2 + 1,
          direction: "left",
          profile: "swing",
          amount: 0.5,
        },
        CLIP_SEC
      );
    }
    expect(moves).toHaveLength(MAX_PERSPECTIVE_MOVES_PER_PLAN);
    expectValid(moves);
  });

  it("refuses a duplicate id", () => {
    const existing = [move({ id: "a" })];
    const moves = addPerspectiveMove(
      existing,
      { id: "a", startSec: 20, endSec: 21, direction: "up", profile: "swing", amount: 0.5 },
      CLIP_SEC
    );
    expect(moves).toBe(existing);
  });

  it("clamps the amount into its bounds", () => {
    const moves = addPerspectiveMove(
      [],
      { id: "a", startSec: 0, endSec: 1, direction: "left", profile: "swing", amount: 9 },
      CLIP_SEC
    );
    expect(moves[0].amount).toBe(PERSPECTIVE_AMOUNT_MAX);
  });
});

describe("nextPerspectiveMoveId", () => {
  it("gives the lowest unused slot, so the same edit gives the same plan", () => {
    expect(nextPerspectiveMoveId([])).toBe("m3d-1");
    expect(nextPerspectiveMoveId([move({ id: "m3d-1" })])).toBe("m3d-2");
    expect(nextPerspectiveMoveId([move({ id: "m3d-2" })])).toBe("m3d-1");
  });
});

describe("setPerspectiveAmount / setPerspectiveProfile", () => {
  it("clamps the amount instead of letting the plan go out of bounds", () => {
    expect(setPerspectiveAmount([move()], "m3d-1", 50)[0].amount).toBe(PERSPECTIVE_AMOUNT_MAX);
    expect(setPerspectiveAmount([move()], "m3d-1", -3)[0].amount).toBe(PERSPECTIVE_AMOUNT_MIN);
    expectValid(setPerspectiveAmount([move()], "m3d-1", 50));
  });

  it("changes the profile without touching the window", () => {
    const moves = setPerspectiveProfile([move()], "m3d-1", "settle");
    expect(moves[0].profile).toBe("settle");
    expect(moves[0].startSec).toBe(5);
    expect(moves[0].endSec).toBe(6);
  });

  it("leaves the list alone for an unknown id", () => {
    const existing = [move()];
    expect(setPerspectiveAmount(existing, "nope", 1)).toEqual(existing);
  });
});

describe("setPerspectiveDirection", () => {
  it("switches axis when the other axis is free", () => {
    const moves = setPerspectiveDirection([move({ direction: "left" })], "m3d-1", "up");
    expect(moves[0].direction).toBe("up");
    expectValid(moves);
  });

  it("refuses a switch that would collide with a move on the target axis", () => {
    const existing = [
      move({ id: "a", direction: "left", startSec: 5, endSec: 8 }),
      move({ id: "b", direction: "up", startSec: 6, endSec: 9 }),
    ];
    // "a" cannot become vertical: "b" already owns that axis over 6–8s.
    expect(setPerspectiveDirection(existing, "a", "down")).toBe(existing);
  });

  it("allows flipping within the same axis, which cannot collide with itself", () => {
    const moves = setPerspectiveDirection([move({ direction: "left" })], "m3d-1", "right");
    expect(moves[0].direction).toBe("right");
  });
});

describe("movePerspectiveMoveTo", () => {
  it("slides a move and keeps its length", () => {
    const moves = movePerspectiveMoveTo([move({ startSec: 5, endSec: 7 })], "m3d-1", 20, CLIP_SEC);
    expect(moves[0].startSec).toBe(20);
    expect(moves[0].endSec).toBe(22);
    expectValid(moves);
  });

  it("clamps a slide past the end of the clip rather than running off it", () => {
    const moves = movePerspectiveMoveTo([move({ startSec: 5, endSec: 7 })], "m3d-1", 999, CLIP_SEC);
    expect(moves[0].endSec).toBeLessThanOrEqual(CLIP_SEC);
    expectValid(moves);
  });

  it("refuses a slide onto a same-axis neighbour", () => {
    const existing = [
      move({ id: "a", direction: "left", startSec: 0, endSec: 2 }),
      move({ id: "b", direction: "right", startSec: 10, endSec: 12 }),
    ];
    expect(movePerspectiveMoveTo(existing, "b", 1, CLIP_SEC)).toBe(existing);
  });

  it("re-sorts the list after a slide", () => {
    const moves = movePerspectiveMoveTo(
      [
        move({ id: "a", direction: "left", startSec: 5, endSec: 7 }),
        move({ id: "b", direction: "up", startSec: 20, endSec: 22 }),
      ],
      "b",
      0,
      CLIP_SEC
    );
    expect(moves.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("setPerspectiveDuration", () => {
  it("stretches a move from its start", () => {
    const moves = setPerspectiveDuration([move({ startSec: 5, endSec: 6 })], "m3d-1", 4, CLIP_SEC);
    expect(moves[0].startSec).toBe(5);
    expect(moves[0].endSec).toBe(9);
    expectValid(moves);
  });

  it("never goes below the minimum visible duration", () => {
    const moves = setPerspectiveDuration([move()], "m3d-1", 0.01, CLIP_SEC);
    expect(moves[0].endSec - moves[0].startSec).toBeGreaterThanOrEqual(
      MIN_PERSPECTIVE_MOVE_DURATION_SEC
    );
    expectValid(moves);
  });

  it("clamps a stretch to the end of the clip", () => {
    const moves = setPerspectiveDuration([move({ startSec: 58, endSec: 59 })], "m3d-1", 30, CLIP_SEC);
    expect(moves[0].endSec).toBeLessThanOrEqual(CLIP_SEC);
    expectValid(moves);
  });

  it("refuses a stretch onto a same-axis neighbour", () => {
    const existing = [
      move({ id: "a", direction: "left", startSec: 0, endSec: 2 }),
      move({ id: "b", direction: "right", startSec: 10, endSec: 12 }),
    ];
    expect(setPerspectiveDuration(existing, "a", 11, CLIP_SEC)).toBe(existing);
  });
});

describe("removePerspectiveMove", () => {
  it("removes only the named move", () => {
    const moves = removePerspectiveMove([move({ id: "a" }), move({ id: "b", startSec: 20, endSec: 21 })], "a");
    expect(moves.map((m) => m.id)).toEqual(["b"]);
    expectValid(moves);
  });

  it("leaves an empty list, which is a flat clip", () => {
    expect(removePerspectiveMove([move()], "m3d-1")).toEqual([]);
  });
});
