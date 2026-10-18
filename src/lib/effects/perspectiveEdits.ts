import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  PERSPECTIVE_AMOUNT_MAX,
  PERSPECTIVE_AMOUNT_MIN,
  perspectiveAxisOf,
  type PerspectiveDirection,
  type PerspectiveMove,
  type PerspectiveProfile,
} from "./types";

/**
 * The edits a user can make to a clip's 3D moves, as pure functions over
 * the move list.
 *
 * Every function here returns a list the server would accept: inside the
 * clip, long enough to be seen, within the count cap, and never two moves
 * fighting over the same axis at the same time. When an edit cannot be
 * made legally it returns the list unchanged rather than a list the
 * export would refuse — the studio is not allowed to build a plan that
 * only fails later, at save or at render.
 *
 * Changing a move's direction can cross axes, which is the one edit that
 * can collide with a move the user is not looking at. It is refused in
 * that case, because silently shifting the other move's timing would
 * change an edit they never touched.
 */

export interface AddPerspectiveMoveInput {
  id: string;
  startSec: number;
  endSec: number;
  direction: PerspectiveDirection;
  profile: PerspectiveProfile;
  amount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The slack kept around a clamped window, for the same reason
 * framingEdits keeps it: clamping to exactly the minimum duration can
 * land a hair under it in binary floating point — 5 + 0.3 - 5 is
 * 0.2999999999999998 — and the validator rightly refuses a move shorter
 * than the minimum. A millisecond of margin costs nothing visible and
 * keeps the limit on the legal side of itself.
 */
const WINDOW_MARGIN_SEC = 0.001;

/** The shortest window an edit may produce, with that margin built in. */
const SHORTEST_WINDOW_SEC = MIN_PERSPECTIVE_MOVE_DURATION_SEC + WINDOW_MARGIN_SEC;

function sortByStart(moves: PerspectiveMove[]): PerspectiveMove[] {
  return [...moves].sort((a, b) => a.startSec - b.startSec);
}

/** True when [startSec, endSec) would collide with another move of the same axis. */
function overlapsOnAxis(
  moves: PerspectiveMove[],
  candidate: { id: string; direction: PerspectiveDirection; startSec: number; endSec: number }
): boolean {
  const axis = perspectiveAxisOf(candidate.direction);
  return moves.some(
    (move) =>
      move.id !== candidate.id &&
      perspectiveAxisOf(move.direction) === axis &&
      candidate.startSec < move.endSec &&
      move.startSec < candidate.endSec
  );
}

/**
 * Adds a move, refusing the ones that cannot hold: past the count cap,
 * shorter than the minimum, outside the clip, or on an axis already busy
 * at that moment. The window is clamped into the clip first, so a preset
 * aimed at "the first second" of a clip shorter than that still lands.
 */
export function addPerspectiveMove(
  moves: PerspectiveMove[],
  input: AddPerspectiveMoveInput,
  clipDurationSec: number
): PerspectiveMove[] {
  if (moves.length >= MAX_PERSPECTIVE_MOVES_PER_PLAN) return moves;
  if (moves.some((move) => move.id === input.id)) return moves;

  const limit = Math.max(0, clipDurationSec) - WINDOW_MARGIN_SEC;
  const startSec = clamp(input.startSec, 0, Math.max(0, limit - SHORTEST_WINDOW_SEC));
  const endSec = clamp(input.endSec, startSec + SHORTEST_WINDOW_SEC, limit);
  if (endSec - startSec < MIN_PERSPECTIVE_MOVE_DURATION_SEC) return moves;

  const candidate: PerspectiveMove = {
    id: input.id,
    startSec,
    endSec,
    direction: input.direction,
    profile: input.profile,
    amount: clamp(input.amount, PERSPECTIVE_AMOUNT_MIN, PERSPECTIVE_AMOUNT_MAX),
  };
  if (overlapsOnAxis(moves, candidate)) return moves;

  return sortByStart([...moves, candidate]);
}

/**
 * The id a newly added move gets: the lowest "m3d-N" the clip is not
 * already using. Derived from the list rather than from a clock so that
 * adding a move is a pure function of the plan — the same edit on the
 * same plan gives the same plan, which is what makes the studio's
 * behaviour testable at all.
 */
export function nextPerspectiveMoveId(moves: PerspectiveMove[]): string {
  const used = new Set(moves.map((move) => move.id));
  for (let n = 1; n <= MAX_PERSPECTIVE_MOVES_PER_PLAN + 1; n++) {
    const candidate = `m3d-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `m3d-${moves.length + 1}`;
}

export function removePerspectiveMove(moves: PerspectiveMove[], moveId: string): PerspectiveMove[] {
  return moves.filter((move) => move.id !== moveId);
}

export function setPerspectiveAmount(
  moves: PerspectiveMove[],
  moveId: string,
  amount: number
): PerspectiveMove[] {
  return moves.map((move) =>
    move.id === moveId
      ? { ...move, amount: clamp(amount, PERSPECTIVE_AMOUNT_MIN, PERSPECTIVE_AMOUNT_MAX) }
      : move
  );
}

export function setPerspectiveProfile(
  moves: PerspectiveMove[],
  moveId: string,
  profile: PerspectiveProfile
): PerspectiveMove[] {
  return moves.map((move) => (move.id === moveId ? { ...move, profile } : move));
}

/** Refused when the new axis is already busy at that moment; see the module note. */
export function setPerspectiveDirection(
  moves: PerspectiveMove[],
  moveId: string,
  direction: PerspectiveDirection
): PerspectiveMove[] {
  const target = moves.find((move) => move.id === moveId);
  if (!target) return moves;
  if (overlapsOnAxis(moves, { ...target, direction })) return moves;
  return moves.map((move) => (move.id === moveId ? { ...move, direction } : move));
}

/** Slides a move along the clip, keeping its length; clamped rather than refused. */
export function movePerspectiveMoveTo(
  moves: PerspectiveMove[],
  moveId: string,
  startSec: number,
  clipDurationSec: number
): PerspectiveMove[] {
  const target = moves.find((move) => move.id === moveId);
  if (!target) return moves;

  const duration = target.endSec - target.startSec;
  const limit = Math.max(0, clipDurationSec) - WINDOW_MARGIN_SEC;
  const start = clamp(startSec, 0, Math.max(0, limit - duration));
  const candidate = { ...target, startSec: start, endSec: start + duration };
  if (overlapsOnAxis(moves, candidate)) return moves;

  return sortByStart(moves.map((move) => (move.id === moveId ? candidate : move)));
}

/** Stretches or shortens a move from its start; clamped to the clip and to its neighbours. */
export function setPerspectiveDuration(
  moves: PerspectiveMove[],
  moveId: string,
  durationSec: number,
  clipDurationSec: number
): PerspectiveMove[] {
  const target = moves.find((move) => move.id === moveId);
  if (!target) return moves;

  const limit = Math.max(0, clipDurationSec) - WINDOW_MARGIN_SEC;
  const longest = Math.max(SHORTEST_WINDOW_SEC, limit - target.startSec);
  const duration = clamp(durationSec, SHORTEST_WINDOW_SEC, longest);
  const candidate = { ...target, endSec: target.startSec + duration };
  if (candidate.endSec > limit) return moves;
  if (overlapsOnAxis(moves, candidate)) return moves;

  return moves.map((move) => (move.id === moveId ? candidate : move));
}
