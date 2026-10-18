import type { DetectedBoundingBox, SubjectTrack } from "./types";

/**
 * Turns a flat list of per-frame detections into subjects followed over
 * time.
 *
 * A detection engine answers "where are the faces in this frame"; it does
 * not necessarily answer "which of these is the same person as before".
 * Framing a short on whoever is speaking needs the second question
 * answered, so this does it: an engine that reports its own `trackId` is
 * believed, and otherwise identity is inferred from position, which is
 * reliable enough for the shape of video this matters for — people
 * sitting and talking, not a crowd walking past.
 *
 * Nothing here invents a subject. Boxes too far apart in space or too far
 * apart in time become separate subjects rather than one subject that
 * teleports, and a "subject" seen in a single sampled frame is dropped:
 * one frame is as likely to be a Haar cascade firing on a bookshelf as a
 * person.
 */

export interface GroupSubjectTracksOptions {
  /**
   * How far a face may move between two sampled frames and still count as
   * the same person, as a fraction of the frame diagonal. At one sample
   * per second a seated speaker moves a few percent; 0.12 tolerates a
   * lean or a gesture without merging two people sitting side by side.
   */
  maxCenterDistance?: number;
  /** A subject unseen for longer than this is closed; a later box starts a new one. */
  maxGapSec?: number;
  /** Subjects with fewer boxes than this are dropped as detector noise. */
  minBoxes?: number;
}

const DEFAULT_MAX_CENTER_DISTANCE = 0.12;
const DEFAULT_MAX_GAP_SEC = 4;
const DEFAULT_MIN_BOXES = 2;

function centerOf(box: DetectedBoundingBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

function distanceBetween(a: DetectedBoundingBox, b: DetectedBoundingBox): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}

function byTimestamp(detections: DetectedBoundingBox[]): Map<number, DetectedBoundingBox[]> {
  const grouped = new Map<number, DetectedBoundingBox[]>();
  for (const box of detections) {
    const list = grouped.get(box.tSec) ?? [];
    list.push(box);
    grouped.set(box.tSec, list);
  }
  return grouped;
}

/** Tracks in order of first appearance, renamed s1, s2… so ids are stable and readable. */
function finalize(tracks: DetectedBoundingBox[][], minBoxes: number): SubjectTrack[] {
  return tracks
    .filter((boxes) => boxes.length >= minBoxes)
    .sort((a, b) => a[0].tSec - b[0].tSec)
    .map((boxes, index) => ({
      id: `s${index + 1}`,
      boxes: [...boxes].sort((a, b) => a.tSec - b.tSec),
    }));
}

export function groupSubjectTracks(
  detections: DetectedBoundingBox[],
  options: GroupSubjectTracksOptions = {}
): SubjectTrack[] {
  const maxCenterDistance = options.maxCenterDistance ?? DEFAULT_MAX_CENTER_DISTANCE;
  const maxGapSec = options.maxGapSec ?? DEFAULT_MAX_GAP_SEC;
  const minBoxes = options.minBoxes ?? DEFAULT_MIN_BOXES;

  if (detections.length === 0) return [];

  // An engine that identifies its own subjects knows better than any
  // heuristic here — but only if it does so for every box. A partially
  // labelled list would silently split one person in two.
  if (detections.every((box) => typeof box.trackId === "string" && box.trackId.length > 0)) {
    const byId = new Map<string, DetectedBoundingBox[]>();
    for (const box of detections) {
      const list = byId.get(box.trackId!) ?? [];
      list.push(box);
      byId.set(box.trackId!, list);
    }
    return [...byId.values()]
      .filter((boxes) => boxes.length >= minBoxes)
      .map((boxes) => [...boxes].sort((a, b) => a.tSec - b.tSec))
      .sort((a, b) => a[0].tSec - b[0].tSec)
      .map((boxes) => ({ id: boxes[0].trackId!, boxes }));
  }

  const grouped = byTimestamp(detections);
  const times = [...grouped.keys()].sort((a, b) => a - b);

  const open: Array<{ boxes: DetectedBoundingBox[]; lastSeenSec: number }> = [];
  const closed: DetectedBoundingBox[][] = [];

  for (const tSec of times) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (tSec - open[i].lastSeenSec > maxGapSec) {
        closed.push(open[i].boxes);
        open.splice(i, 1);
      }
    }

    const boxes = grouped.get(tSec)!;

    // Every (box, open subject) pair, closest first: a greedy pass over
    // sorted distances keeps the obvious matches obvious, instead of
    // letting the first box in an arbitrary order claim a subject that
    // the second box was much closer to.
    const pairs: Array<{ boxIndex: number; trackIndex: number; distance: number }> = [];
    boxes.forEach((box, boxIndex) => {
      open.forEach((track, trackIndex) => {
        const distance = distanceBetween(box, track.boxes[track.boxes.length - 1]);
        if (distance <= maxCenterDistance) {
          pairs.push({ boxIndex, trackIndex, distance });
        }
      });
    });
    pairs.sort((a, b) => a.distance - b.distance);

    const usedBoxes = new Set<number>();
    const usedTracks = new Set<number>();
    for (const pair of pairs) {
      if (usedBoxes.has(pair.boxIndex) || usedTracks.has(pair.trackIndex)) continue;
      usedBoxes.add(pair.boxIndex);
      usedTracks.add(pair.trackIndex);
      open[pair.trackIndex].boxes.push(boxes[pair.boxIndex]);
      open[pair.trackIndex].lastSeenSec = tSec;
    }

    boxes.forEach((box, boxIndex) => {
      if (usedBoxes.has(boxIndex)) return;
      open.push({ boxes: [box], lastSeenSec: tSec });
    });
  }

  return finalize([...closed, ...open.map((track) => track.boxes)], minBoxes);
}

/**
 * Where a subject is at a given time: the median of the boxes inside
 * [fromSec, toSec], or the nearest box in time when that window happens
 * to hold none.
 *
 * The median rather than the mean, and a window rather than one instant,
 * because a single sampled box is sometimes half a face or a false
 * positive one frame wide, and a mean lets that one box drag the framing
 * for the whole shot.
 */
export function subjectCenterIn(
  track: SubjectTrack,
  fromSec: number,
  toSec: number
): { cx: number; cy: number } | null {
  if (track.boxes.length === 0) return null;

  const inside = track.boxes.filter((box) => box.tSec >= fromSec && box.tSec <= toSec);
  const sample =
    inside.length > 0
      ? inside
      : [
          track.boxes.reduce((best, box) => {
            const mid = (fromSec + toSec) / 2;
            return Math.abs(box.tSec - mid) < Math.abs(best.tSec - mid) ? box : best;
          }, track.boxes[0]),
        ];

  const xs = sample.map((box) => box.x + box.width / 2).sort((a, b) => a - b);
  const ys = sample.map((box) => box.y + box.height / 2).sort((a, b) => a - b);
  const middle = Math.floor(sample.length / 2);
  const median = (values: number[]): number =>
    values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;

  return { cx: median(xs), cy: median(ys) };
}
