import {
  FRAMING_LABEL_MAX_LENGTH,
  MAX_FRAMING_SHOTS_PER_PLAN,
  MIN_FRAMING_SHOT_DURATION_SEC,
  type FramingShot,
} from "@/lib/effects/types";
import type { NormalizedRect } from "@/lib/domain/types";
import { cropRectAround } from "./deriveCropFromTrack";
import type { SpeechTurn } from "./speechTurns";
import type { DetectedBoundingBox } from "./types";

/**
 * The shot list of a clip: where the vertical frame sits, and from when to
 * when, so that it is on the face of whoever is talking.
 *
 * The decision is made moment by moment, shot by shot, rather than by
 * matching each voice to one face for the whole video. That earlier design
 * could not work on what people actually clip: an edited show cuts between
 * angles every second or two, the same person appears on the left of one
 * shot and on the right of the next, and a face detected before a cut has
 * nothing to do with the face at the same place after it. Diarization does
 * not help either — one person often comes back under several labels.
 *
 * So, for each stretch between two camera cuts:
 * - one face on screen (a close-up): the frame is on it;
 * - several faces (a wide shot): the frame is on the one whose mouth moves
 *   most while someone is speaking, compared with the others *at the same
 *   moment*, under the same light — a comparison that holds where a
 *   video-wide average does not; when no face clearly moves more, the
 *   frame stays where it was, or goes to the most present face;
 * - no face at all: the frame stays where it was.
 *
 * The frame changes on the camera cuts themselves, where a change of crop
 * is invisible, and between two speakers inside a long wide shot, in the
 * pause between them.
 */

export interface BuildFaceFramingInput {
  /** Every detection of the video, absolute times. */
  detections: DetectedBoundingBox[];
  /** The video's camera cuts, absolute seconds. Empty for a continuous shot or an engine that does not report them. */
  cuts: number[];
  /** Absolute-timed speech turns: when someone is talking, and when the voice changes. */
  turns: SpeechTurn[];
  clipStartSec: number;
  clipEndSec: number;
  /** Output aspect ratio (e.g. 9/16) and source dimensions, to size the crop window. */
  targetAspect: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Shortest switch between two people inside one camera shot; shorter ones are absorbed. */
  minSwitchSec?: number;
}

export interface FaceFramingResult {
  /** Clip-relative shots; empty when one framing holds for the whole clip. */
  shots: FramingShot[];
  /** Where the frame is for most of the clip — the static crop when there are no shots. Null when no face was seen at all. */
  dominantCenter: { cx: number; cy: number } | null;
  notes: string[];
}

/** A switch between two people faster than this reads as a glitch rather than as a cut. */
const DEFAULT_MIN_SWITCH_SEC = 1.2;
/** Faces smaller than this share of the largest one in the shot are background or false detections. */
const MIN_RELATIVE_FACE_HEIGHT = 0.6;
/** Two detections closer than this (fraction of the frame width) are the same person within a shot. */
const SAME_FACE_DISTANCE = 0.1;
/** How much more a mouth must move than every other one to be called the speaker's. */
const ACTIVITY_MARGIN = 1.3;
/** Two framings closer than this are the same framing: changing between them would be a cut nobody sees. */
const SAME_FRAMING_DISTANCE = 0.03;
/** Detection samples are a second apart: a turn looks at the faces a little around itself. */
const ACTIVITY_LOOKAROUND_SEC = 0.5;
const EPSILON = 1e-6;

interface Center {
  cx: number;
  cy: number;
}

interface FaceCluster {
  center: Center;
  boxes: DetectedBoundingBox[];
  height: number;
}

interface Piece {
  /** Absolute seconds. */
  startSec: number;
  endSec: number;
  center: Center | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function centerOf(box: DetectedBoundingBox): Center {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

function sameFraming(a: Center | null, b: Center | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.cx - b.cx) < SAME_FRAMING_DISTANCE && Math.abs(a.cy - b.cy) < SAME_FRAMING_DISTANCE;
}

/** The camera shots overlapping the clip, each with its full extent in the video (it may start before the clip). */
function cameraShotsOf(cuts: number[], clipStartSec: number, clipEndSec: number): Array<{ startSec: number; endSec: number }> {
  const ordered = [...cuts].sort((a, b) => a - b);
  const before = ordered.filter((cut) => cut <= clipStartSec + EPSILON);
  const inside = ordered.filter((cut) => cut > clipStartSec + EPSILON && cut < clipEndSec - EPSILON);
  const after = ordered.find((cut) => cut >= clipEndSec - EPSILON);
  const bounds = [before.length > 0 ? before[before.length - 1] : -Infinity, ...inside, after ?? Infinity];
  const shots: Array<{ startSec: number; endSec: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) shots.push({ startSec: bounds[i], endSec: bounds[i + 1] });
  return shots;
}

/** The people in one camera shot: its detections grouped by position, background faces left out. */
function facesIn(detections: DetectedBoundingBox[]): FaceCluster[] {
  if (detections.length === 0) return [];
  const tallest = Math.max(...detections.map((box) => box.height));
  const kept = detections.filter((box) => box.height >= tallest * MIN_RELATIVE_FACE_HEIGHT);

  const clusters: Array<{ boxes: DetectedBoundingBox[] }> = [];
  for (const box of [...kept].sort((a, b) => centerOf(a).cx - centerOf(b).cx)) {
    const cx = centerOf(box).cx;
    const near = clusters.find((cluster) => Math.abs(median(cluster.boxes.map((b) => centerOf(b).cx)) - cx) < SAME_FACE_DISTANCE);
    if (near) near.boxes.push(box);
    else clusters.push({ boxes: [box] });
  }
  return clusters.map(({ boxes }) => ({
    boxes,
    center: { cx: median(boxes.map((b) => centerOf(b).cx)), cy: median(boxes.map((b) => centerOf(b).cy)) },
    height: median(boxes.map((b) => b.height)),
  }));
}

/** Mean mouth activity of a face over a window, or null when it was not measured there. */
function activityIn(face: FaceCluster, fromSec: number, toSec: number): number | null {
  const measured = face.boxes
    .filter((box) => box.tSec >= fromSec - ACTIVITY_LOOKAROUND_SEC && box.tSec <= toSec + ACTIVITY_LOOKAROUND_SEC)
    .map((box) => box.activity)
    .filter((activity): activity is number => typeof activity === "number" && Number.isFinite(activity));
  return measured.length === 0 ? null : measured.reduce((sum, value) => sum + value, 0) / measured.length;
}

/** The face that is clearly talking over a window, or null when none clearly is. */
function talkingFace(faces: FaceCluster[], fromSec: number, toSec: number): FaceCluster | null {
  const scored = faces
    .map((face) => ({ face, activity: activityIn(face, fromSec, toSec) }))
    .filter((entry): entry is { face: FaceCluster; activity: number } => entry.activity !== null)
    .sort((a, b) => b.activity - a.activity);
  if (scored.length === 0 || scored[0].activity <= 0) return null;
  if (scored.length > 1 && scored[0].activity < scored[1].activity * ACTIVITY_MARGIN) return null;
  return scored[0].face;
}

/** The face nearest to a framing, if one is close enough to be the same person. */
function faceAt(faces: FaceCluster[], center: Center | null): FaceCluster | null {
  if (!center) return null;
  return faces.find((face) => Math.abs(face.center.cx - center.cx) < SAME_FACE_DISTANCE) ?? null;
}

/** The most present face of a shot: seen most often, then the largest. */
function mostPresent(faces: FaceCluster[]): FaceCluster {
  return [...faces].sort((a, b) => b.boxes.length - a.boxes.length || b.height - a.height)[0];
}

/**
 * Who to frame inside one camera shot with several people in it: a piece
 * per speech turn, each on the face that talks during it, merged when it
 * is the same face, and too-short switches given back to their neighbours.
 */
function framePeopleInShot(
  faces: FaceCluster[],
  turns: SpeechTurn[],
  fromSec: number,
  toSec: number,
  previous: Center | null,
  minSwitchSec: number
): Piece[] {
  const fallback = (faceAt(faces, previous) ?? mostPresent(faces)).center;
  const shotTurns = turns
    .map((turn) => ({ startSec: Math.max(turn.startSec, fromSec), endSec: Math.min(turn.endSec, toSec) }))
    .filter((turn) => turn.endSec > turn.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  if (shotTurns.length === 0) return [{ startSec: fromSec, endSec: toSec, center: fallback }];

  // One piece per turn, then the silences between them split down the
  // middle so that a switch lands in the pause.
  const pieces: Piece[] = [];
  let current = fallback;
  for (const turn of shotTurns) {
    current = (talkingFace(faces, turn.startSec, turn.endSec) ?? faceAt(faces, current) ?? mostPresent(faces)).center;
    pieces.push({ ...turn, center: current });
  }
  pieces[0].startSec = fromSec;
  for (let i = 1; i < pieces.length; i++) {
    const middle = (pieces[i - 1].endSec + Math.max(pieces[i].startSec, pieces[i - 1].endSec)) / 2;
    pieces[i - 1].endSec = middle;
    pieces[i].startSec = middle;
  }
  pieces[pieces.length - 1].endSec = toSec;

  // A switch too short to read is given to the longer neighbour.
  return absorbShortPieces(pieces, minSwitchSec);
}

/** Gives every piece shorter than `minSec` to its longer neighbour, merging equal framings as it goes. */
function absorbShortPieces(pieces: Piece[], minSec: number): Piece[] {
  let merged = mergeSameFraming(pieces);
  for (;;) {
    if (merged.length <= 1) return merged;
    const index = merged.findIndex((piece) => piece.endSec - piece.startSec < minSec - EPSILON);
    if (index === -1) return merged;
    const previousPiece = merged[index - 1];
    const nextPiece = merged[index + 1];
    const into =
      previousPiece && (!nextPiece || previousPiece.endSec - previousPiece.startSec >= nextPiece.endSec - nextPiece.startSec)
        ? previousPiece
        : nextPiece;
    if (into === previousPiece) into.endSec = merged[index].endSec;
    else into.startSec = merged[index].startSec;
    merged.splice(index, 1);
    merged = mergeSameFraming(merged);
  }
}

function mergeSameFraming(pieces: Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && sameFraming(last.center, piece.center)) {
      last.endSec = piece.endSec;
      continue;
    }
    merged.push({ ...piece });
  }
  return merged;
}

/** Keeps the cap by giving the shortest pieces to their longer neighbour. */
function capPieces(pieces: Piece[], notes: string[]): Piece[] {
  if (pieces.length <= MAX_FRAMING_SHOTS_PER_PLAN) return pieces;
  notes.push(
    `Ce clip demande ${pieces.length} changements de cadrage : seuls ${MAX_FRAMING_SHOTS_PER_PLAN} sont gardés, les plus courts sont absorbés par leurs voisins.`
  );
  const kept = pieces.map((piece) => ({ ...piece }));
  while (kept.length > MAX_FRAMING_SHOTS_PER_PLAN) {
    let shortest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].endSec - kept[i].startSec < kept[shortest].endSec - kept[shortest].startSec) shortest = i;
    }
    const previous = kept[shortest - 1];
    const next = kept[shortest + 1];
    if (previous && (!next || previous.endSec - previous.startSec >= next.endSec - next.startSec)) {
      previous.endSec = kept[shortest].endSec;
    } else if (next) {
      next.startSec = kept[shortest].startSec;
    }
    kept.splice(shortest, 1);
  }
  return mergeSameFraming(kept);
}

export function buildFaceFraming(input: BuildFaceFramingInput): FaceFramingResult {
  const { clipStartSec, clipEndSec } = input;
  if (!(clipEndSec > clipStartSec)) {
    return { shots: [], dominantCenter: null, notes: ["Clip de durée nulle : aucun plan de cadrage."] };
  }
  const minSwitchSec = input.minSwitchSec ?? DEFAULT_MIN_SWITCH_SEC;
  const notes: string[] = [];

  const pieces: Piece[] = [];
  let previous: Center | null = null;
  let shotsWithoutFace = 0;
  for (const cameraShot of cameraShotsOf(input.cuts, clipStartSec, clipEndSec)) {
    // The whole camera shot is looked at, even the part outside the clip:
    // a shot cut short by the clip's edge is still the same people.
    const faces = facesIn(
      input.detections.filter((box) => box.tSec >= cameraShot.startSec && box.tSec < cameraShot.endSec)
    );
    const fromSec = Math.max(cameraShot.startSec, clipStartSec);
    const toSec = Math.min(cameraShot.endSec, clipEndSec);

    if (faces.length === 0) {
      shotsWithoutFace++;
      pieces.push({ startSec: fromSec, endSec: toSec, center: previous });
      continue;
    }
    const inShot: Piece[] =
      faces.length === 1
        ? [{ startSec: fromSec, endSec: toSec, center: faces[0].center }]
        : framePeopleInShot(faces, input.turns, fromSec, toSec, previous, minSwitchSec);
    pieces.push(...inShot);
    previous = inShot[inShot.length - 1].center;
  }

  // A shot with no face before the first face of the clip has no framing
  // to keep yet: it takes the first one that comes.
  const firstCenter = pieces.find((piece) => piece.center)?.center ?? null;
  if (!firstCenter) {
    return {
      shots: [],
      dominantCenter: null,
      notes: ["Aucun visage détecté dans ce clip : le cadrage reste centré."],
    };
  }
  for (const piece of pieces) {
    if (!piece.center) piece.center = firstCenter;
    else break;
  }
  if (shotsWithoutFace > 0) {
    notes.push(`${shotsWithoutFace} plan(s) sans visage détecté : le cadrage y garde le précédent.`);
  }

  // A camera cut a few frames from the clip's edge, or two cuts in quick
  // succession, leave slivers of shot. The plan refuses any shot shorter
  // than MIN_FRAMING_SHOT_DURATION_SEC — and a refused plan is a plan not
  // applied at all — so a sliver takes its neighbour's framing, which on a
  // tenth of a second nobody sees.
  const merged = capPieces(absorbShortPieces(pieces, MIN_FRAMING_SHOT_DURATION_SEC), notes);
  // The same person in two camera shots is two measurements of one
  // framing: durations are added up by position, not by shot.
  const durationBy = new Map<string, { center: Center; durationSec: number }>();
  for (const piece of merged) {
    const center = piece.center!;
    const key = `${Math.round(center.cx / SAME_FRAMING_DISTANCE)}:${Math.round(center.cy / SAME_FRAMING_DISTANCE)}`;
    const entry = durationBy.get(key) ?? { center, durationSec: 0 };
    entry.durationSec += piece.endSec - piece.startSec;
    durationBy.set(key, entry);
  }
  const dominantCenter = [...durationBy.values()].sort((a, b) => b.durationSec - a.durationSec)[0].center;

  if (merged.length < 2) return { shots: [], dominantCenter, notes };

  const crop = (center: Center): NormalizedRect =>
    cropRectAround(center.cx, center.cy, {
      targetAspect: input.targetAspect,
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
    });
  const shots: FramingShot[] = merged.map((piece, index) => ({
    id: `shot-${index + 1}`,
    startSec: piece.startSec - clipStartSec,
    endSec: piece.endSec - clipStartSec,
    rect: crop(piece.center!),
    // On a camera cut a change of crop is invisible; between two people
    // in one shot it is a cut too, never a pan that would draw the eye to
    // the crop instead of to who is talking.
    transitionSec: 0,
    source: "speaker",
    label: `Visage ${index + 1}`.slice(0, FRAMING_LABEL_MAX_LENGTH),
  }));
  return { shots, dominantCenter, notes };
}
