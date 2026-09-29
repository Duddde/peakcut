/**
 * Frame-tracking abstraction for crop-following.
 *
 * IMPORTANT: nothing in this module performs real face/subject detection.
 * The only implementation shipped (StableCenterFrameTracker) is a
 * deterministic, explicit fallback: it always centers the crop and always
 * reports `fallbackUsed: true` with a low confidence. Any future adapter
 * backed by a real detection model must be explicit about it (a distinct
 * `method`, and `fallbackUsed: false` only when a model actually ran).
 */

export interface TrackingKeyframe {
  tSec: number;
  /** Normalized center X in [0, 1] of the source frame the crop should follow at this time. */
  cx: number;
  /** Normalized center Y in [0, 1] of the source frame. */
  cy: number;
  /** Confidence in [0, 1] that this keyframe reflects a real subject position. */
  confidence: number;
}

export interface FrameTrack {
  keyframes: TrackingKeyframe[];
  /** True whenever no real subject-detection model produced this track. */
  fallbackUsed: boolean;
  /** Identifies the method that produced this track, for transparency (e.g. "centered-fallback-no-face-model"). */
  method: string;
}

export interface FrameTrackerInput {
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
  /** Required by trackers that inspect real content (e.g. LocalSubjectTracker); ignored by pure fallbacks. */
  mediaPath?: string;
}

export interface FrameTracker {
  readonly id: string;
  readonly displayName: string;
  track(input: FrameTrackerInput): Promise<FrameTrack>;
}

/**
 * A single detected subject's bounding box at one point in time, as
 * reported by a SubjectDetectionEngine. Normalized to the source frame.
 */
export interface DetectedBoundingBox {
  tSec: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Detector's own confidence in [0, 1]. */
  score: number;
  /** Stable identity across frames, if the engine supports it. */
  trackId?: string;
}

export interface SubjectDetectionInput {
  mediaPath: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
}

/**
 * Injectable real subject-detection backend. PeakCut ships no built-in ML
 * model — see CommandSubjectDetectionEngine for the one real, optional
 * implementation (a local external command).
 */
export interface SubjectDetectionEngine {
  readonly id: string;
  detect(input: SubjectDetectionInput): Promise<DetectedBoundingBox[]>;
}
