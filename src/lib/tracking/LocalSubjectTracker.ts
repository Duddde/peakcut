import { assertLocalFileExists } from "@/lib/transcript/transcriptHttp";
import { groupSubjectTracks } from "./subjectTracks";
import type {
  DetectedBoundingBox,
  FrameTrack,
  FrameTracker,
  FrameTrackerInput,
  SubjectDetectionEngine,
  TrackingKeyframe,
} from "./types";

/**
 * Real subject-following tracker: delegates actual detection to an
 * injected SubjectDetectionEngine (PeakCut ships no built-in model — see
 * CommandSubjectDetectionEngine for the one optional real backend). This
 * class only does the generic, model-agnostic work: picking one "main
 * subject" per timestamp, converting its box to a center point, smoothing
 * that path over time, and reporting whether a real detection actually
 * happened.
 *
 * `fallbackUsed` is false only when the engine returned at least one real
 * detection; if it returns zero (a legitimate "nothing detected in this
 * clip" outcome) this falls back to the same centered behavior as
 * StableCenterFrameTracker, clearly flagged as a fallback. If the engine
 * itself throws (misconfiguration, crash, timeout), that error propagates
 * — this never silently swallows a real failure into a fallback.
 */

export interface LocalSubjectTrackerOptions {
  /** Moving-average window (in samples) applied to the selected centers. Clamped to [1, 9]. */
  smoothingWindow?: number;
}

const MIN_SMOOTHING_WINDOW = 1;
const MAX_SMOOTHING_WINDOW = 9;
const DEFAULT_SMOOTHING_WINDOW = 3;
const FALLBACK_CONFIDENCE = 0.3;
const CENTER = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface SelectedPoint {
  tSec: number;
  cx: number;
  cy: number;
  confidence: number;
  trackId?: string;
}

/**
 * Picks the "main" subject among simultaneous detections: prefers the same
 * identity as the previous pick when the engine supplies trackIds
 * (continuity), otherwise a blend of raw prominence (score × area) and
 * proximity to the previous pick (so a fleeting, distant high-score box
 * doesn't yank the crop away from the subject actually being followed).
 */
function selectMainSubject(boxes: DetectedBoundingBox[], previous: SelectedPoint | null): DetectedBoundingBox {
  if (previous?.trackId) {
    const sameTrack = boxes.find((b) => b.trackId === previous.trackId);
    if (sameTrack) return sameTrack;
  }

  function metric(b: DetectedBoundingBox): number {
    const area = Math.max(0, b.width) * Math.max(0, b.height);
    const prominence = Math.max(0, b.score) * area;
    if (!previous) return prominence;
    const bcx = b.x + b.width / 2;
    const bcy = b.y + b.height / 2;
    const distance = Math.hypot(bcx - previous.cx, bcy - previous.cy);
    const continuity = 1 / (1 + distance * 5);
    return prominence * (0.5 + 0.5 * continuity);
  }

  let best = boxes[0];
  let bestMetric = metric(best);
  for (const box of boxes.slice(1)) {
    const m = metric(box);
    if (m > bestMetric) {
      best = box;
      bestMetric = m;
    }
  }
  return best;
}

/** Index of the camera shot a time falls in: how many cuts precede it. */
function shotIndexAt(tSec: number, cuts: number[]): number {
  return cuts.filter((cut) => cut <= tSec).length;
}

/**
 * Moving average of the selected positions, never across a camera cut:
 * averaging the last point of one shot with the first of the next puts the
 * frame halfway between two faces, on neither.
 */
function smoothPoints(points: SelectedPoint[], window: number, cuts: number[] = []): SelectedPoint[] {
  if (window <= 1 || points.length <= 1) return points;
  const half = Math.floor(window / 2);
  const shots = points.map((point) => shotIndexAt(point.tSec, cuts));
  return points.map((point, i) => {
    let start = Math.max(0, i - half);
    let end = Math.min(points.length - 1, i + half);
    while (shots[start] !== shots[i]) start++;
    while (shots[end] !== shots[i]) end--;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let j = start; j <= end; j++) {
      sumX += points[j].cx;
      sumY += points[j].cy;
      count++;
    }
    return { ...point, cx: sumX / count, cy: sumY / count };
  });
}

export class LocalSubjectTracker implements FrameTracker {
  readonly id = "local-subject";
  readonly displayName = "Suivi de sujet local (moteur de détection externe requis)";

  constructor(
    private readonly engine: SubjectDetectionEngine,
    private readonly options: LocalSubjectTrackerOptions = {}
  ) {}

  async track(input: FrameTrackerInput): Promise<FrameTrack> {
    if (!input.mediaPath) {
      throw new Error("LocalSubjectTracker requiert mediaPath dans FrameTrackerInput.");
    }
    await assertLocalFileExists(input.mediaPath);

    const detectionInput = {
      mediaPath: input.mediaPath,
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
      durationSec: input.durationSec,
    };
    const { detections, cuts } = this.engine.detectScene
      ? await this.engine.detectScene(detectionInput)
      : { detections: await this.engine.detect(detectionInput), cuts: [] as number[] };

    if (detections.length === 0) {
      const durationSec = Math.max(0, input.durationSec);
      const times = durationSec === 0 ? [0] : [0, durationSec];
      return {
        keyframes: times.map((tSec) => ({
          tSec,
          cx: CENTER,
          cy: CENTER,
          confidence: FALLBACK_CONFIDENCE,
        })),
        fallbackUsed: true,
        method: "local-subject-no-detections-fallback",
        subjects: [],
        cuts,
      };
    }

    const byTime = new Map<number, DetectedBoundingBox[]>();
    for (const box of detections) {
      const list = byTime.get(box.tSec) ?? [];
      list.push(box);
      byTime.set(box.tSec, list);
    }
    const times = [...byTime.keys()].sort((a, b) => a - b);

    const rawPoints: SelectedPoint[] = [];
    let previous: SelectedPoint | null = null;
    for (const t of times) {
      const boxes = byTime.get(t)!;
      const selected = selectMainSubject(boxes, previous);
      const point: SelectedPoint = {
        tSec: t,
        cx: clamp01(selected.x + selected.width / 2),
        cy: clamp01(selected.y + selected.height / 2),
        confidence: clamp01(selected.score),
        trackId: selected.trackId,
      };
      rawPoints.push(point);
      previous = point;
    }

    const window = Math.min(
      MAX_SMOOTHING_WINDOW,
      Math.max(MIN_SMOOTHING_WINDOW, Math.round(this.options.smoothingWindow ?? DEFAULT_SMOOTHING_WINDOW))
    );
    const smoothed = smoothPoints(rawPoints, window, cuts);

    const keyframes: TrackingKeyframe[] = smoothed.map((p) => ({
      tSec: p.tSec,
      cx: clamp01(p.cx),
      cy: clamp01(p.cy),
      confidence: p.confidence,
    }));

    return {
      keyframes,
      fallbackUsed: false,
      method: "local-subject-detection",
      // The keyframes follow one subject; this keeps all of them, which is
      // what framing a clip on whoever is speaking needs (see
      // buildFaceFraming). Grouping happens here rather than in the
      // caller because this is the only layer that sees every detection.
      subjects: groupSubjectTracks(detections),
      cuts,
      detections,
    };
  }
}
