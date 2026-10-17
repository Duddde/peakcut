/**
 * What "a short" lasts, in one place.
 *
 * Two independent parts of PeakCut need this number and must never
 * disagree: the candidate selector (segmentTranscript), which only builds
 * windows inside the plateau, and the scorer (scoreSegment), whose
 * duration factor rewards it. When they drifted apart the generator
 * proposed clips the scorer then docked, and the ranking silently fought
 * the selection.
 *
 * The target is a clip of about a minute: long enough to carry a real
 * idea with a beginning and an end, short enough for Shorts/Reels/TikTok
 * feeds. The plateau is deliberately wider than that target, because
 * boundaries land on sentence ends — a narrow window would often contain
 * no legal cut at all and the moment would be dropped entirely.
 */

/** Below this, a clip is a fragment, not a story: factor 0. */
export const MIN_VIABLE_SEC = 3;

/** Start of the ideal plateau — the shortest clip not penalised at all. */
export const IDEAL_MIN_SEC = 50;

/** End of the ideal plateau — the longest clip not penalised at all. */
export const IDEAL_MAX_SEC = 95;

/**
 * Past this, the duration factor is 0. Not a hard ban: a long clip can
 * still be selected on its other merits, and an over-long lone sentence
 * is still offered rather than making that stretch of video unreachable.
 */
export const TOO_LONG_SEC = 240;

/**
 * How well a duration fits the short-form target, in [0, 1]: a ramp up
 * from MIN_VIABLE_SEC, a flat 1 across the plateau, then a ramp down to 0
 * at TOO_LONG_SEC.
 */
export function shortFormDurationFactor(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= MIN_VIABLE_SEC) return 0;
  if (durationSec < IDEAL_MIN_SEC) return (durationSec - MIN_VIABLE_SEC) / (IDEAL_MIN_SEC - MIN_VIABLE_SEC);
  if (durationSec <= IDEAL_MAX_SEC) return 1;
  if (durationSec < TOO_LONG_SEC) return 1 - (durationSec - IDEAL_MAX_SEC) / (TOO_LONG_SEC - IDEAL_MAX_SEC);
  return 0;
}
