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
  /**
   * Every subject the detection saw, not just the one the keyframes
   * follow. A single centered path cannot express "two people, and the
   * frame should be on whoever is talking"; this is what makes that
   * possible downstream (see buildFaceFraming). Absent on trackers
   * that have no notion of separate subjects.
   */
  subjects?: SubjectTrack[];
  /**
   * The source's camera cuts, in seconds, when the engine reports them.
   * The frame has to change exactly there, and a face before a cut is not
   * the face at the same place after it (see buildFaceFraming).
   */
  cuts?: number[];
  /**
   * Every detection, ungrouped. The framing needs the faces seen only once:
   * in a show that changes angle every second, a close-up is often a
   * single detection, which subject grouping drops as noise.
   */
  detections?: DetectedBoundingBox[];
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
  /**
   * How much this subject's mouth region moved around this timestamp, in
   * [0, 1], for engines that measure it (see scripts/vision/track_faces.py).
   *
   * Undefined means "not measured", and that is deliberately not the same
   * value as 0: a face reported as perfectly still is evidence that it is
   * not the one speaking, while a face whose motion nobody measured is no
   * evidence at all. Conflating the two would let an engine that reports
   * nothing decide who the active speaker is.
   */
  activity?: number;
}

/**
 * One subject followed across time: the same face, from the frame it
 * appears in to the frame it leaves.
 *
 * Detection engines report independent boxes per sampled frame; which of
 * them are the same person is inferred afterwards (see
 * groupSubjectTracks) or taken from the engine when it supplies
 * `trackId`. Everything that reasons about *who* is in frame — matching a
 * voice to a face, framing a shot on one of two people — needs this, not
 * a flat list of boxes.
 */
export interface SubjectTrack {
  id: string;
  /** Chronological, one box per sampled timestamp at most. */
  boxes: DetectedBoundingBox[];
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
/** What an engine that also watches the editing reports: the faces, and the camera cuts. */
export interface SceneDetection {
  detections: DetectedBoundingBox[];
  cuts: number[];
}

export interface SubjectDetectionEngine {
  readonly id: string;
  detect(input: SubjectDetectionInput): Promise<DetectedBoundingBox[]>;
  /** Optional: the faces and the camera cuts in one pass. Engines without it report no cuts. */
  detectScene?(input: SubjectDetectionInput): Promise<SceneDetection>;
}
