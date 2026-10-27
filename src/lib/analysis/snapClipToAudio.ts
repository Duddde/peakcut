import { quietestMoment, type ReadAudioEnvelope } from "@/lib/ffmpeg/audioEnvelope";

/**
 * Moves a clip's start and end onto the quietest moment of the audio
 * around them.
 *
 * The transcript says which word a clip ends on, but not exactly when
 * that word ends: word timings are estimated within each phrase the model
 * returns, and a cut on that estimate regularly clips the last syllable —
 * the person is cut off before they have finished. Within a short window
 * around each bound the cut goes where the audio is quietest instead: the
 * pause after the last word, the breath before the first one.
 *
 * The window reaches further after the end than before it: cutting a
 * little late costs a breath of silence, cutting early costs the end of a
 * word.
 */

/** How far an end may move, in seconds: a little earlier, more later. */
export const END_WINDOW = { beforeSec: 0.15, afterSec: 0.8 };
/**
 * How far a start may move: only back, into the pause before the first
 * word — moving it forward would drop that word from the clip.
 */
export const START_WINDOW = { beforeSec: 0.5, afterSec: 0 };
/** Envelope resolution: fine enough to land between two words. */
const FRAME_SEC = 0.02;

export interface ClipBounds {
  startSec: number;
  endSec: number;
}

export async function snapClipToAudio(
  mediaPath: string,
  bounds: ClipBounds,
  readEnvelope: ReadAudioEnvelope,
  sourceDurationSec: number
): Promise<ClipBounds> {
  const startFrom = Math.max(0, bounds.startSec - START_WINDOW.beforeSec);
  const startTo = bounds.startSec + START_WINDOW.afterSec;
  const endFrom = bounds.endSec - END_WINDOW.beforeSec;
  const endTo = sourceDurationSec > 0 ? Math.min(sourceDurationSec, bounds.endSec + END_WINDOW.afterSec) : bounds.endSec + END_WINDOW.afterSec;

  const [startEnvelope, endEnvelope] = await Promise.all([
    readEnvelope(mediaPath, startFrom, startTo - startFrom, FRAME_SEC),
    readEnvelope(mediaPath, endFrom, endTo - endFrom, FRAME_SEC),
  ]);
  const startSec = quietestMoment(startEnvelope, startFrom, startTo, bounds.startSec) ?? bounds.startSec;
  const endSec = quietestMoment(endEnvelope, endFrom, endTo, bounds.endSec) ?? bounds.endSec;
  return endSec > startSec ? { startSec, endSec } : bounds;
}
