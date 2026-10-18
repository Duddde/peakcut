import {
  FRAMING_LABEL_MAX_LENGTH,
  MAX_FRAMING_SHOTS_PER_PLAN,
  type FramingShot,
} from "@/lib/effects/types";
import { cropRectAround } from "./deriveCropFromTrack";
import type { SpeakerFaceAssignment } from "./assignSpeakersToFaces";
import type { SpeechTurn } from "./speechTurns";
import { turnsWithin } from "./speechTurns";
import { subjectCenterIn } from "./subjectTracks";
import type { SubjectTrack } from "./types";

/**
 * The shot list of a clip: who the frame is on, and from when to when.
 *
 * This is where "the video must be framed on the face of the person
 * speaking" stops being an intention and becomes a value the export
 * compiles. It takes the two real measurements — the transcript's
 * diarized turns and the detected faces, already matched to each other by
 * assignSpeakersToFaces — and turns them into the clip-relative shots of
 * a RenderPlan.
 *
 * Most of the work here is editorial rather than algorithmic, and that is
 * the point. Raw turns make a terrible shot list: a two-word interjection
 * would become a quarter-second cut to the other face and back, which
 * reads as a broken player rather than as an edit. So short turns are
 * absorbed into their neighbours, silences are split down the middle
 * (the cut lands in the pause, where a human editor puts it), and the
 * clip is covered end to end so the crop never snaps back to a default
 * framing mid-sentence.
 */

export interface BuildSpeakerFramingInput {
  tracks: SubjectTrack[];
  /** Absolute-timed diarized turns, as produced by speechTurnsFromWords. */
  turns: SpeechTurn[];
  assignment: SpeakerFaceAssignment;
  /** The clip's window in the source, in absolute seconds. */
  clipStartSec: number;
  clipEndSec: number;
  /** Output aspect ratio (e.g. 9/16) and source dimensions, to size the crop window. */
  targetAspect: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Shortest shot kept; shorter ones are absorbed by a neighbour. */
  minShotSec?: number;
}

export interface SpeakerFramingResult {
  shots: FramingShot[];
  /** Why there are no shots, or fewer than the turns would suggest. */
  notes: string[];
}

/**
 * A cut to the other face lands badly under about a second: the eye needs
 * time to find the new framing, and a shot shorter than that is read as a
 * glitch. Short-form editing cuts fast, but it cuts fast between *shots*,
 * not within a sentence.
 */
const DEFAULT_MIN_SHOT_SEC = 1.2;
const EPSILON = 1e-6;

interface Interval {
  trackId: string;
  speaker: string;
  startSec: number;
  endSec: number;
}

function sanitizeLabel(speaker: string): string {
  const cleaned = [...speaker].filter((char) => char >= " " && char !== "\u007f").join("").trim();
  return `Intervenant ${cleaned}`.slice(0, FRAMING_LABEL_MAX_LENGTH);
}

/** Turns, in clip time, reduced to the ones whose speaker has a known face. */
function assignedIntervals(input: BuildSpeakerFramingInput): Interval[] {
  const clipTurns = turnsWithin(input.turns, input.clipStartSec, input.clipEndSec);
  const intervals: Interval[] = [];
  for (const turn of clipTurns) {
    const trackId = input.assignment.bySpeaker[turn.speaker];
    if (!trackId) continue;
    intervals.push({ trackId, speaker: turn.speaker, startSec: turn.startSec, endSec: turn.endSec });
  }
  return intervals.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Consecutive turns of the same person become one shot, however long the
 * silence between them: cutting away from a face and back to the same
 * framing is a cut nobody can see, and it would spend two of the plan's
 * shots on nothing. Two turns of the same speaker are only consecutive
 * here when nobody else spoke in between — someone else speaking is what
 * makes a shot change.
 */
function mergeSameSubject(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && previous.trackId === interval.trackId) {
      previous.endSec = Math.max(previous.endSec, interval.endSec);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

/**
 * Covers the clip from 0 to its end with no holes: the first shot starts
 * at 0, the last ends at the clip's end, and the silence between two
 * speakers is split in half so the cut lands in the pause rather than on
 * the first syllable of the answer.
 */
function tileClip(intervals: Interval[], clipDurationSec: number): Interval[] {
  if (intervals.length === 0) return [];
  const tiled = intervals.map((interval) => ({ ...interval }));

  tiled[0].startSec = 0;
  for (let i = 1; i < tiled.length; i++) {
    const gap = tiled[i].startSec - tiled[i - 1].endSec;
    if (gap > 0) {
      const middle = tiled[i - 1].endSec + gap / 2;
      tiled[i - 1].endSec = middle;
      tiled[i].startSec = middle;
    } else {
      tiled[i].startSec = tiled[i - 1].endSec;
    }
  }
  tiled[tiled.length - 1].endSec = clipDurationSec;

  return tiled;
}

/** Gives a too-short shot's time to the neighbour that can best carry it. */
function absorbInto(intervals: Interval[], index: number): Interval[] {
  const kept = [...intervals];
  const shot = kept[index];
  const previous = index > 0 ? kept[index - 1] : null;
  const next = index + 1 < kept.length ? kept[index + 1] : null;

  if (previous && next) {
    const previousDuration = previous.endSec - previous.startSec;
    const nextDuration = next.endSec - next.startSec;
    if (previousDuration >= nextDuration) {
      previous.endSec = shot.endSec;
    } else {
      next.startSec = shot.startSec;
    }
  } else if (previous) {
    previous.endSec = shot.endSec;
  } else if (next) {
    next.startSec = shot.startSec;
  }

  kept.splice(index, 1);
  return kept;
}

function enforceMinimumDuration(intervals: Interval[], minShotSec: number): Interval[] {
  let kept = intervals;
  for (;;) {
    if (kept.length <= 1) return kept;
    const index = kept.findIndex((shot) => shot.endSec - shot.startSec < minShotSec - EPSILON);
    if (index === -1) return kept;
    kept = absorbInto(kept, index);
  }
}

function enforceShotCap(intervals: Interval[], notes: string[]): Interval[] {
  let kept = intervals;
  if (kept.length <= MAX_FRAMING_SHOTS_PER_PLAN) return kept;

  notes.push(
    `Ce clip change d'intervenant ${kept.length} fois : seuls ${MAX_FRAMING_SHOTS_PER_PLAN} plans de cadrage sont conservés, les plus courts ont été absorbés par leurs voisins.`
  );
  while (kept.length > MAX_FRAMING_SHOTS_PER_PLAN) {
    let shortest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].endSec - kept[i].startSec < kept[shortest].endSec - kept[shortest].startSec) {
        shortest = i;
      }
    }
    kept = absorbInto(kept, shortest);
  }
  return kept;
}

export function buildSpeakerFraming(input: BuildSpeakerFramingInput): SpeakerFramingResult {
  const notes: string[] = [];
  const clipDurationSec = input.clipEndSec - input.clipStartSec;
  if (!(clipDurationSec > 0)) {
    return { shots: [], notes: ["Clip de durée nulle : aucun plan de cadrage."] };
  }

  const minShotSec = input.minShotSec ?? DEFAULT_MIN_SHOT_SEC;

  const intervals = assignedIntervals(input);
  if (intervals.length === 0) {
    return {
      shots: [],
      notes: [
        "Aucune prise de parole de ce clip n'est rattachée à un visage identifié : le cadrage reste celui du clip.",
      ],
    };
  }

  const merged = mergeSameSubject(intervals);
  const tiled = tileClip(merged, clipDurationSec);
  const withMinimum = enforceMinimumDuration(tiled, minShotSec);
  const capped = enforceShotCap(withMinimum, notes);

  const distinctSubjects = new Set(capped.map((shot) => shot.trackId));
  if (distinctSubjects.size < 2) {
    // One subject for the whole clip is exactly what a single static crop
    // already does. Writing it as a shot list would claim the frame
    // follows the speaker when nothing ever moves.
    return {
      shots: [],
      notes: [
        "Un seul intervenant identifié parle dans ce clip : le cadrage statique le suit déjà, aucun plan de cadrage n'est ajouté.",
      ],
    };
  }

  const tracksById = new Map(input.tracks.map((track) => [track.id, track]));
  const shots: FramingShot[] = [];
  for (const [index, interval] of capped.entries()) {
    const track = tracksById.get(interval.trackId);
    // Boxes are timed in the source; the interval is clip-relative.
    const center = track
      ? subjectCenterIn(track, input.clipStartSec + interval.startSec, input.clipStartSec + interval.endSec)
      : null;
    if (!center) {
      notes.push(`Sujet "${interval.trackId}" introuvable dans la détection : plan de cadrage ignoré.`);
      continue;
    }

    shots.push({
      id: `shot-${index + 1}`,
      startSec: interval.startSec,
      endSec: interval.endSec,
      rect: cropRectAround(center.cx, center.cy, {
        targetAspect: input.targetAspect,
        sourceWidth: input.sourceWidth,
        sourceHeight: input.sourceHeight,
      }),
      // A speaker change is a cut, not a pan: gliding the crop from one
      // face to the other draws attention to the crop instead of to who
      // is talking. The user can set a pan in the studio if they want one.
      transitionSec: 0,
      source: "speaker",
      label: sanitizeLabel(interval.speaker),
    });
  }

  if (shots.length < 2) {
    return {
      shots: [],
      notes: [...notes, "Pas assez de plans de cadrage exploitables : le cadrage du clip est conservé."],
    };
  }

  return { shots, notes };
}
