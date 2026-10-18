import type { NormalizedRect } from "@/lib/domain/types";
import {
  FRAMING_TRANSITION_SEC_MAX,
  FRAMING_TRANSITION_SEC_MIN,
  MIN_FRAMING_SHOT_DURATION_SEC,
  type FramingShot,
} from "./types";

/**
 * The edits a user can make to a clip's framing, as pure functions over
 * the shot list.
 *
 * Every function here preserves the two properties the compiler and the
 * validator depend on: the shots stay in order and they stay contiguous,
 * covering the clip with no gap and no overlap. That is why the time
 * controls move a *boundary* between two shots rather than one shot's
 * start and the next one's end independently — the second shape lets a
 * user build a hole in the middle of their clip, where the crop would
 * snap back to a framing they never chose, and lets them build an overlap,
 * where which shot wins is an accident of branch order.
 *
 * Deleting is the same idea: a shot's time is given to a neighbour
 * instead of being left vacant, and deleting the one before last clears
 * the framing entirely, because a single shot is exactly what one static
 * crop already does.
 */

export interface FramingSubject {
  /** The shot label, which is the subject's identity as the detection named it. */
  label: string;
  /** A representative crop window for that subject. */
  rect: NormalizedRect;
  shotCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The slack kept on each side of a clamped boundary.
 *
 * Without it, clamping a cut to exactly the minimum shot duration can
 * land a hair under it: 40 - (40 - 0.4) is 0.3999999999999986 in binary
 * floating point, and the validator — rightly — refuses a shot shorter
 * than the minimum. A millisecond of margin costs nothing visible and
 * keeps the limit on the legal side of itself. Same reason as
 * overlayEdits' SPAN_MARGIN_SEC.
 */
const BOUNDARY_MARGIN_SEC = 0.001;

/**
 * The distinct subjects a clip's framing moves between, in order of first
 * appearance. Identity comes from the label rather than from the
 * rectangle: two shots on the same person are measured over different
 * stretches of video and their windows differ by a pixel or two, which is
 * no reason to offer the user the same person twice.
 */
export function framingSubjects(shots: FramingShot[]): FramingSubject[] {
  const subjects: FramingSubject[] = [];
  for (const shot of shots) {
    const label = shot.label ?? "Sujet sans nom";
    const existing = subjects.find((subject) => subject.label === label);
    if (existing) {
      existing.shotCount++;
      continue;
    }
    subjects.push({ label, rect: shot.rect, shotCount: 1 });
  }
  return subjects;
}

/**
 * Moves the cut between shot `index` and the one after it.
 *
 * Both shots keep at least the minimum duration, so the move is clamped
 * rather than refused: dragging a cut past its neighbour is an ordinary
 * thing to do with a mouse, and stopping at the limit is what every
 * editor does.
 */
export function moveFramingBoundary(shots: FramingShot[], index: number, tSec: number): FramingShot[] {
  if (index < 0 || index >= shots.length - 1) return shots;

  const before = shots[index];
  const after = shots[index + 1];
  const earliest = before.startSec + MIN_FRAMING_SHOT_DURATION_SEC + BOUNDARY_MARGIN_SEC;
  const latest = after.endSec - MIN_FRAMING_SHOT_DURATION_SEC - BOUNDARY_MARGIN_SEC;
  if (latest < earliest) return shots;

  const boundary = clamp(tSec, earliest, latest);

  return shots.map((shot, i) => {
    if (i === index) return { ...shot, endSec: boundary };
    if (i === index + 1) {
      return {
        ...shot,
        startSec: boundary,
        // A pan can never be longer than the shot it opens; shortening the
        // shot shortens the pan with it rather than invalidating the plan.
        transitionSec: Math.min(shot.transitionSec, after.endSec - boundary),
      };
    }
    return shot;
  });
}

/** Points one shot at another subject of the clip; the choice is the user's, so the shot becomes theirs. */
export function retargetFramingShot(
  shots: FramingShot[],
  shotId: string,
  subject: FramingSubject
): FramingShot[] {
  return shots.map((shot) =>
    shot.id === shotId ? { ...shot, rect: subject.rect, label: subject.label, source: "manual" } : shot
  );
}

export function setFramingTransition(shots: FramingShot[], shotId: string, transitionSec: number): FramingShot[] {
  return shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    const duration = shot.endSec - shot.startSec;
    return {
      ...shot,
      transitionSec: clamp(transitionSec, FRAMING_TRANSITION_SEC_MIN, Math.min(FRAMING_TRANSITION_SEC_MAX, duration)),
      source: "manual",
    };
  });
}

/**
 * Removes a shot and gives its time to a neighbour, so the clip stays
 * covered. Removing the one before last clears the framing: one shot is
 * one static crop, and saying otherwise would claim the frame follows
 * someone when nothing ever moves.
 */
export function removeFramingShot(shots: FramingShot[], shotId: string): FramingShot[] {
  const index = shots.findIndex((shot) => shot.id === shotId);
  if (index === -1) return shots;
  if (shots.length <= 2) return [];

  const kept = shots.map((shot) => ({ ...shot }));
  const removed = kept[index];
  if (index > 0) {
    kept[index - 1].endSec = removed.endSec;
  } else {
    kept[index + 1].startSec = removed.startSec;
    kept[index + 1].transitionSec = 0;
  }
  kept.splice(index, 1);
  return kept;
}
