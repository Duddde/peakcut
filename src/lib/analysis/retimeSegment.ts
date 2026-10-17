import type { Segment, Transcript, TranscriptWord } from "@/lib/domain/types";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { retimeRenderPlan } from "@/lib/effects/retimeRenderPlan";

/**
 * Moving a clip's boundaries, with everything that hangs off them.
 *
 * A segment is not just two numbers: it carries the slice of transcript
 * burned in as subtitles, a score computed from that slice, and an
 * editing plan expressed in clip-relative time. Dragging an edge used to
 * change only the numbers, so a trimmed clip kept the captions of its old
 * length — words appeared for speech the clip no longer contained — and
 * kept a score describing a cut that no longer existed.
 *
 * This keeps the four in step. It is pure: the caller owns persistence.
 */

/** The words of `transcript` that fall inside [startSec, endSec). */
export function wordsWithin(words: TranscriptWord[], startSec: number, endSec: number): TranscriptWord[] {
  return words.filter((word) => word.startSec >= startSec && word.startSec < endSec);
}

export interface RetimeSegmentOptions {
  startSec: number;
  endSec: number;
  /**
   * The project's full transcript, when it has one. Without it the
   * segment's own words are re-filtered instead: trimming still drops
   * what falls outside, but extending cannot bring back words the
   * segment never held — there is nowhere to read them from.
   */
  transcript?: Transcript | null;
}

export function retimeSegment(segment: Segment, options: RetimeSegmentOptions): Segment {
  const startSec = Math.max(0, Math.min(options.startSec, options.endSec));
  const endSec = Math.max(options.startSec, options.endSec);

  const source = options.transcript?.words ?? segment.words;
  const words = wordsWithin(source, startSec, endSec);

  return {
    ...segment,
    startSec,
    endSec,
    words,
    score: scoreSegment({ words, startSec, endSec }),
    renderPlan: segment.renderPlan ? retimeRenderPlan(segment.renderPlan, endSec - startSec) : null,
  };
}

/**
 * Splits a clip in two at `atSec` (absolute, in source time), returning
 * the pair in chronological order — the timeline's "cut here" action.
 *
 * Returns null when the point lies outside the clip, or when either side
 * would be shorter than `minPartSec`: a zero-width clip is not an edit,
 * it is a mistake, and silently producing one would leave the user with
 * a segment they cannot see or select.
 */
export function splitSegment(
  segment: Segment,
  atSec: number,
  options: { transcript?: Transcript | null; idFor: (half: "left" | "right") => string; minPartSec?: number }
): [Segment, Segment] | null {
  const minPartSec = options.minPartSec ?? 1;
  if (!(atSec > segment.startSec + minPartSec) || !(atSec < segment.endSec - minPartSec)) {
    return null;
  }

  const left = retimeSegment(
    { ...segment, id: options.idFor("left") },
    { startSec: segment.startSec, endSec: atSec, transcript: options.transcript }
  );
  const right = retimeSegment(
    { ...segment, id: options.idFor("right") },
    { startSec: atSec, endSec: segment.endSec, transcript: options.transcript }
  );
  return [left, right];
}
