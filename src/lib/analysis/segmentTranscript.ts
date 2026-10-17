import type { Segment, TranscriptWord } from "@/lib/domain/types";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { IDEAL_MAX_SEC, IDEAL_MIN_SEC } from "@/lib/domain/shortFormDuration";

/**
 * Candidate-clip selection: turns one long transcript into a handful of
 * distinct, sentence-aligned short-form candidates, ranked by the existing
 * explainable scorer.
 *
 * This is deliberately a *selector*, not a model. It proposes where a human
 * editor should look first; it decides nothing. Every candidate it returns
 * carries the same traceable Score explanation as a hand-drawn segment, and
 * the ranking is nothing more than that score sorted — there is no separate,
 * hidden notion of "interesting" anywhere in here.
 *
 * Three rules shape the candidates:
 *
 * 1. Boundaries land on sentence ends, never mid-sentence. A clip that opens
 *    halfway through a clause is unusable regardless of how well it scores,
 *    so those windows are never built in the first place.
 * 2. Durations target [MIN_DURATION_SEC, MAX_DURATION_SEC], which is exactly
 *    the plateau where scoreSegment's own durationFactor equals 1. The
 *    scorer and the generator therefore agree on what "short-form length"
 *    means, instead of the generator proposing clips the scorer then docks.
 * 3. Selected candidates never overlap. Overlapping windows over a strong
 *    moment would otherwise fill the whole list with near-duplicates of it
 *    and bury every other moment in the video.
 */

/**
 * The target window, re-exported from the one place that defines what a
 * short lasts. Keeping the names here means every caller that already
 * imports them keeps working while there is still a single source of
 * truth shared with the scorer.
 */
export const MIN_DURATION_SEC = IDEAL_MIN_SEC;
export const MAX_DURATION_SEC = IDEAL_MAX_SEC;

/** Default cap on how many candidates are proposed for review. */
export const DEFAULT_MAX_CANDIDATES = 8;

export interface SegmentTranscriptOptions {
  minDurationSec?: number;
  maxDurationSec?: number;
  maxCandidates?: number;
}

/** A sentence-sized run of words, the atom every candidate is built from. */
interface SentenceUnit {
  words: TranscriptWord[];
  startSec: number;
  endSec: number;
}

const SENTENCE_END = /[.!?…]["»')\]]*$/;

/**
 * Groups words into sentence units on terminal punctuation carried by the
 * transcript itself. A transcript whose provider emits no punctuation at
 * all yields one unit per word, which still produces valid (if less
 * natural) boundaries rather than nothing at all.
 */
export function splitIntoSentenceUnits(words: TranscriptWord[]): SentenceUnit[] {
  const units: SentenceUnit[] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    current.push(word);
    if (SENTENCE_END.test(word.text.trim())) {
      units.push(toUnit(current));
      current = [];
    }
  }
  if (current.length > 0) units.push(toUnit(current));

  return units;
}

function toUnit(words: TranscriptWord[]): SentenceUnit {
  return {
    words,
    startSec: words[0].startSec,
    endSec: words[words.length - 1].endSec,
  };
}

export interface SegmentCandidate {
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
  score: ReturnType<typeof scoreSegment>;
}

/**
 * Every sentence-aligned window whose duration fits the target range, plus
 * any single sentence too long to fit one — without that exception, a
 * stretch of video covered by one long unpunctuated run would be
 * unreachable, and the editor would never be shown it at all.
 */
export function buildCandidates(
  units: SentenceUnit[],
  minDurationSec: number,
  maxDurationSec: number
): SegmentCandidate[] {
  const candidates: SegmentCandidate[] = [];

  for (let i = 0; i < units.length; i++) {
    let words: TranscriptWord[] = [];
    for (let j = i; j < units.length; j++) {
      words = words.concat(units[j].words);
      const startSec = units[i].startSec;
      const endSec = units[j].endSec;
      const durationSec = endSec - startSec;

      if (durationSec > maxDurationSec) {
        // A lone over-long sentence is still offered; a multi-sentence
        // window that overshoots is not, since a shorter prefix of it
        // already fit and was emitted.
        if (j === i) {
          candidates.push({ startSec, endSec, words: [...words], score: scoreSegment({ words, startSec, endSec }) });
        }
        break;
      }
      if (durationSec >= minDurationSec) {
        candidates.push({ startSec, endSec, words: [...words], score: scoreSegment({ words, startSec, endSec }) });
      }
    }
  }

  return candidates;
}

/**
 * Highest score first, then earliest, keeping only candidates that do not
 * overlap an already-selected one. Ties broken by position so the result is
 * deterministic for a given transcript — two runs of the analysis on
 * unchanged input must produce the same clips.
 */
export function selectNonOverlapping(
  candidates: SegmentCandidate[],
  maxCandidates: number
): SegmentCandidate[] {
  const ordered = [...candidates].sort(
    (a, b) => b.score.value - a.score.value || a.startSec - b.startSec || a.endSec - b.endSec
  );

  const selected: SegmentCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.length >= maxCandidates) break;
    const overlaps = selected.some((s) => candidate.startSec < s.endSec && s.startSec < candidate.endSec);
    if (!overlaps) selected.push(candidate);
  }

  return selected.sort((a, b) => a.startSec - b.startSec);
}

export interface BuildSegmentOptions {
  projectId: string;
  /** Injectable so segment ids are deterministic in tests. */
  idFor: (index: number) => string;
  buildSafeZones: (segmentId: string) => Segment["safeZones"];
  buildVariants: (segmentId: string) => Segment["variants"];
  /**
   * The editing plan each candidate starts from (see
   * lib/effects/defaultRenderPlanFor). Injected rather than imported so
   * this module stays a pure selector with no opinion about effects;
   * omitted, candidates carry no plan and export as a static crop.
   */
  buildRenderPlan?: (segmentId: string, candidate: SegmentCandidate) => Segment["renderPlan"];
}

/**
 * Selects candidate clips from a transcript and returns them as scored
 * Segments, ordered chronologically.
 *
 * Returns an empty array when the transcript holds no word at all. A
 * transcript too short to yield any window in range produces a single
 * candidate covering everything it has, so a genuinely short source still
 * gets one segment to work from instead of nothing.
 */
export function segmentTranscript(
  words: TranscriptWord[],
  build: BuildSegmentOptions,
  options: SegmentTranscriptOptions = {}
): Segment[] {
  if (words.length === 0) return [];

  const minDurationSec = options.minDurationSec ?? MIN_DURATION_SEC;
  const maxDurationSec = options.maxDurationSec ?? MAX_DURATION_SEC;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const units = splitIntoSentenceUnits(words);
  const candidates = buildCandidates(units, minDurationSec, maxDurationSec);

  const selected =
    candidates.length > 0
      ? selectNonOverlapping(candidates, maxCandidates)
      : [wholeTranscriptCandidate(words)];

  return selected.map((candidate, index) => {
    const id = build.idFor(index);
    return {
      id,
      projectId: build.projectId,
      title: titleFor(candidate, index),
      startSec: candidate.startSec,
      endSec: candidate.endSec,
      words: candidate.words,
      score: candidate.score,
      safeZones: build.buildSafeZones(id),
      variants: build.buildVariants(id),
      renderPlan: build.buildRenderPlan?.(id, candidate) ?? null,
    };
  });
}

function wholeTranscriptCandidate(words: TranscriptWord[]): SegmentCandidate {
  const startSec = words[0].startSec;
  const endSec = words[words.length - 1].endSec;
  return { startSec, endSec, words, score: scoreSegment({ words, startSec, endSec }) };
}

/**
 * The opening words of the clip, which is what an editor scans a list of
 * candidates by. Titles stay editable afterwards, exactly like a
 * hand-drawn segment's.
 */
function titleFor(candidate: SegmentCandidate, index: number): string {
  const opening = candidate.words
    .slice(0, 8)
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (opening.length === 0) return `Candidat ${index + 1}`;
  return opening.length > 70 ? `${opening.slice(0, 67)}...` : opening;
}
