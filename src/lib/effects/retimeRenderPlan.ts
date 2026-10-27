import {
  MIN_CUT_DURATION_SEC,
  MIN_FRAMING_SHOT_DURATION_SEC,
  MIN_OVERLAY_DURATION_SEC,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  ZOOM_SCALE_MIN,
  type FramingShot,
  type Overlay,
  type PerspectiveMove,
  type RenderPlan,
} from "./types";
import { retimeMotionCards } from "@/lib/motion/types";

/** Clip-relative time, kept inside the clip it belongs to. */
function clampToClip(tSec: number, lastEnd: number): number {
  return Math.min(Math.max(tSec, 0), lastEnd);
}

/**
 * Illustrations follow the clip too: one that now ends past the end is
 * shortened, and one left shorter than it takes to see is dropped rather
 * than kept as a flash. Its fade is shortened with it, since a fade
 * longer than half the overlay is exactly what the validator refuses.
 */
function retimeOverlays(overlays: Overlay[], lastEnd: number): Overlay[] {
  const retimed: Overlay[] = [];
  for (const overlay of overlays) {
    const startSec = clampToClip(overlay.startSec, lastEnd);
    const endSec = clampToClip(overlay.endSec, lastEnd);
    const duration = endSec - startSec;
    if (duration < MIN_OVERLAY_DURATION_SEC) continue;
    retimed.push({ ...overlay, startSec, endSec, fadeSec: Math.min(overlay.fadeSec, duration / 2) });
  }
  return retimed;
}

/**
 * Framing follows the clip too, and one rule here is not obvious: a shot
 * the trim leaves too short to be a shot is given to the one before it
 * rather than dropped. Dropping it would leave the end of the clip with
 * no shot at all, and the crop would snap back to the base framing for
 * the last second — the clip would end by looking away from whoever is
 * speaking. Absorbing it keeps the clip covered from end to end.
 */
function retimeFraming(framing: FramingShot[], lastEnd: number): FramingShot[] {
  const sorted = [...framing].sort((a, b) => a.startSec - b.startSec);
  const kept: FramingShot[] = [];

  for (const shot of sorted) {
    const startSec = clampToClip(shot.startSec, lastEnd);
    const endSec = clampToClip(shot.endSec, lastEnd);
    const duration = endSec - startSec;

    if (duration < MIN_FRAMING_SHOT_DURATION_SEC) {
      if (kept.length > 0 && endSec > kept[kept.length - 1].endSec) {
        kept[kept.length - 1] = { ...kept[kept.length - 1], endSec };
      }
      continue;
    }

    kept.push({ ...shot, startSec, endSec, transitionSec: Math.min(shot.transitionSec, duration) });
  }

  return kept;
}

/**
 * 3D moves follow the clip the same way illustrations do: one the trim
 * cuts into keeps whatever window is left and replays its profile over
 * it, and one left too short to be seen is dropped rather than kept as a
 * lurch. Unlike a framing shot, a dropped move costs nothing structural —
 * the frame goes back to flat, which is what a clip without 3D does.
 */
function retimePerspectiveMoves(moves: PerspectiveMove[], lastEnd: number): PerspectiveMove[] {
  const retimed: PerspectiveMove[] = [];
  for (const move of moves) {
    const startSec = clampToClip(move.startSec, lastEnd);
    const endSec = clampToClip(move.endSec, lastEnd);
    if (endSec - startSec < MIN_PERSPECTIVE_MOVE_DURATION_SEC) continue;
    retimed.push({ ...move, startSec, endSec });
  }
  return retimed;
}

/**
 * Re-fits a clip's plan to a new clip duration.
 *
 * A RenderPlan's times are clip-relative: a cut of 0→60 s and keyframes
 * inside it. Trim the clip to 40 s and that plan describes something that
 * no longer exists — validateRenderPlan rejects a keyframe outside the
 * cut range, so saving the trimmed clip would be refused and the user
 * would be stuck between an edit they made and effects they never
 * touched.
 *
 * So trimming retimes the plan instead of invalidating it: the cut
 * follows the clip, keyframes beyond the new end are dropped, and the
 * curve keeps its shape over whatever is left. Nothing is invented — no
 * keyframe is added, none is moved — the plan is only cut down to the
 * clip it belongs to.
 *
 * `offsetSec` is how much later in the source the clip now begins, and it
 * is what makes dragging the *left* edge — or cutting a clip in two —
 * keep its edit. Clip-relative time is measured from the clip's start, so
 * moving that start by 20 s without moving the plan leaves every effect
 * describing a different 20 seconds of video: a zoom that punches on the
 * wrong word, an illustration over the wrong sentence, and a frame on the
 * person who is listening. The second half of a split clip is exactly
 * that case.
 */
export function retimeRenderPlan(plan: RenderPlan, durationSec: number, offsetSec = 0): RenderPlan {
  const duration = Math.max(0, durationSec);
  const offset = Number.isFinite(offsetSec) ? offsetSec : 0;

  if (duration < MIN_CUT_DURATION_SEC) {
    // Too short to carry a cut at all; same degradation buildRenderPlan applies.
    return {
      ...plan,
      cuts: [],
      zoomKeyframes: [{ tSec: 0, scale: ZOOM_SCALE_MIN }],
      overlays: [],
      framing: [],
      perspectiveMoves: [],
      motion: [],
    };
  }

  const cuts = plan.cuts
    .map((cut) => ({
      startSec: clampToClip(cut.startSec - offset, duration),
      endSec: clampToClip(cut.endSec - offset, duration),
    }))
    .filter((cut) => cut.endSec - cut.startSec >= MIN_CUT_DURATION_SEC);

  const effectiveCuts = cuts.length > 0 ? cuts : [{ startSec: 0, endSec: duration }];
  const lastEnd = Math.max(...effectiveCuts.map((cut) => cut.endSec));

  const keyframes = plan.zoomKeyframes
    .map((kf) => ({ ...kf, tSec: kf.tSec - offset }))
    .filter((kf) => kf.tSec >= 0 && kf.tSec <= lastEnd);

  return {
    ...plan,
    cuts: effectiveCuts,
    overlays: retimeOverlays(
      plan.overlays.map((overlay) => ({
        ...overlay,
        startSec: overlay.startSec - offset,
        endSec: overlay.endSec - offset,
      })),
      lastEnd
    ),
    framing: retimeFraming(
      plan.framing.map((shot) => ({ ...shot, startSec: shot.startSec - offset, endSec: shot.endSec - offset })),
      lastEnd
    ),
    perspectiveMoves: retimePerspectiveMoves(
      plan.perspectiveMoves.map((move) => ({
        ...move,
        startSec: move.startSec - offset,
        endSec: move.endSec - offset,
      })),
      lastEnd
    ),
    ...(plan.motion ? { motion: retimeMotionCards(plan.motion, lastEnd, offset) } : {}),
    // A clip always keeps at least one keyframe: an empty list would make
    // the export fall back to a static crop without saying why.
    zoomKeyframes: keyframes.length > 0 ? keyframes : [{ tSec: 0, scale: ZOOM_SCALE_MIN }],
  };
}
