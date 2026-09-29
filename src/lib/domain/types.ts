/**
 * Domain model for PeakCut.
 *
 * PeakCut helps a human editor find and cut candidate short-form segments
 * from a long-form video. Every score produced by this system is an
 * explainable *editorial signal*, not a prediction of watch time, views,
 * or virality. See src/lib/scoring/README.md for the explicit disclaimer.
 */

export type SourceType = "youtube" | "local-upload";

export interface Source {
  id: string;
  type: SourceType;
  /** Present only when type === "youtube". Never downloaded automatically. */
  youtubeUrl?: string;
  /** Present only when type === "local-upload". Path is local to the machine running PeakCut. */
  localFilePath?: string;
  title: string;
  durationSec: number;
  /** ISO timestamp of when this source was ingested/registered by PeakCut (not the original upload date on a platform). */
  originTimestamp: string;
  /**
   * Confidence, in [0, 1], in the *metadata* describing this source — not a
   * content-quality or virality signal. 1.0 for a locally-provided file
   * (the user supplied the bytes directly); lower for a YouTube URL, whose
   * actual availability/visibility PeakCut cannot verify without contacting
   * YouTube (which it deliberately does not do here).
   */
  confidence: number;
}

export type WordSpeaker = string;

export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
  speaker?: WordSpeaker;
  /** 0..1 confidence reported by the transcript provider. */
  confidence: number;
}

export interface Transcript {
  language: string;
  words: TranscriptWord[];
  /** Name of the TranscriptProvider that produced this transcript. */
  providerId: string;
}

/** Normalized rectangle, all values in [0, 1] relative to frame width/height. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SafeZonePurpose =
  | "subtitle-area"
  | "platform-ui-top"
  | "platform-ui-bottom"
  | "custom";

/** A region of the frame that must remain unobstructed by burned-in captions or crop. */
export interface SafeZone {
  id: string;
  purpose: SafeZonePurpose;
  rect: NormalizedRect;
  label: string;
}

export interface ScoreBreakdown {
  /** Strength of the opening line as an attention hook (0..1). */
  hook: number;
  /** Ratio of distinct meaningful words to total words (0..1). */
  lexicalDensity: number;
  /** Presence of a question, which invites curiosity (0..1). */
  question: number;
  /** Presence of emotionally charged language (0..1). */
  emotion: number;
  /** Number of speaker changes inside the segment, normalized (0..1). */
  speakerChange: number;
  /** How close the segment duration is to the ideal short-form range (0..1). */
  duration: number;
  /** Sum of penalty deductions applied (0..1, subtracted from the raw score). */
  penalties: number;
}

export interface ScoreExplanation {
  breakdown: ScoreBreakdown;
  /** Human-readable reasons behind the breakdown, one per non-zero factor. */
  reasons: string[];
  /** Human-readable reasons a penalty was applied. */
  penaltyReasons: string[];
}

export interface Score {
  /** Final editorial-interest score in [0, 100]. NOT a watch-time or virality prediction. */
  value: number;
  /** Confidence in the score itself, in [0, 1], based on transcript quality and segment length. */
  confidence: number;
  explanation: ScoreExplanation;
}

export type CropAspectRatio = "9:16" | "1:1" | "4:5" | "16:9";

export interface Variant {
  id: string;
  label: string;
  aspectRatio: CropAspectRatio;
  crop: NormalizedRect;
}

export interface Segment {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  /** Editable title shown to the user, distinct from the transcript. */
  title: string;
  /** Word-by-word transcript slice belonging to this segment. */
  words: TranscriptWord[];
  score: Score | null;
  safeZones: SafeZone[];
  variants: Variant[];
}

export type TimelineTrackKind = "video" | "subtitle";

export interface TimelineClip {
  id: string;
  trackKind: TimelineTrackKind;
  segmentId: string;
  startSec: number;
  endSec: number;
}

export interface Timeline {
  clips: TimelineClip[];
  totalDurationSec: number;
}

export type ProjectStatus =
  | "draft"
  | "transcribing"
  | "scoring"
  | "ready-for-review"
  | "approved";

/**
 * Explicit workflow model. PeakCut recognizes exactly two phases:
 *
 * - "analysis_preview": the default. The project can be explored, edited,
 *   and scored, but nothing can be exported yet.
 * - "export_authorized": a human has explicitly confirmed they hold the
 *   necessary rights over the source, unlocking local export.
 *
 * There is deliberately no third "published" phase — see PublicationPolicy.
 */
export type WorkflowPhase = "analysis_preview" | "export_authorized";

/**
 * PeakCut never implements a publish/distribute action anywhere in this
 * codebase. This is not a runtime switch that could be flipped to "on" —
 * it is a standing, literal-typed invariant carried on every workflow so
 * the UI and any consumer can always see and state it explicitly.
 */
export type PublicationPolicy = "publication_never_implicit";

export const PUBLICATION_POLICY: PublicationPolicy = "publication_never_implicit";

/** A human's explicit confirmation that they hold the rights necessary to use this source. */
export interface RightsConfirmation {
  confirmed: boolean;
  confirmedAt: string | null;
  /** Free-text local identifier (e.g. a name or email), never an auth token or secret. */
  confirmedBy: string | null;
}

export interface WorkflowState {
  phase: WorkflowPhase;
  publicationPolicy: PublicationPolicy;
  rights: RightsConfirmation;
}

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  source: Source;
  transcript: Transcript | null;
  segments: Segment[];
  timeline: Timeline | null;
  workflow: WorkflowState;
}
