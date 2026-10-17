import { MIN_CUT_DURATION_SEC, ZOOM_SCALE_MIN, type RenderPlan } from "./types";

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
 */
export function retimeRenderPlan(plan: RenderPlan, durationSec: number): RenderPlan {
  const duration = Math.max(0, durationSec);

  if (duration < MIN_CUT_DURATION_SEC) {
    // Too short to carry a cut at all; same degradation buildRenderPlan applies.
    return { ...plan, cuts: [], zoomKeyframes: [{ tSec: 0, scale: ZOOM_SCALE_MIN }] };
  }

  const cuts = plan.cuts
    .map((cut) => ({ startSec: Math.min(cut.startSec, duration), endSec: Math.min(cut.endSec, duration) }))
    .filter((cut) => cut.endSec - cut.startSec >= MIN_CUT_DURATION_SEC);

  const effectiveCuts = cuts.length > 0 ? cuts : [{ startSec: 0, endSec: duration }];
  const lastEnd = Math.max(...effectiveCuts.map((cut) => cut.endSec));

  const keyframes = plan.zoomKeyframes.filter((kf) => kf.tSec <= lastEnd);

  return {
    ...plan,
    cuts: effectiveCuts,
    // A clip always keeps at least one keyframe: an empty list would make
    // the export fall back to a static crop without saying why.
    zoomKeyframes: keyframes.length > 0 ? keyframes : [{ tSec: 0, scale: ZOOM_SCALE_MIN }],
  };
}
