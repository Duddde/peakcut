import type { NormalizedRect, SafeZone } from "@/lib/domain/types";

/**
 * Declarative, bounded "effect template" plan for a segment export.
 *
 * A RenderPlan never claims more than PeakCut actually does. Fields whose
 * intent is not yet applied by the real ffmpeg export pipeline (multi-cut
 * detection, frame-accurate zoom keyframing, audio ducking) are still
 * produced and validated here — for transparency and future
 * implementation — but every RenderPlan carries an explicit `limitations`
 * list saying so, and nothing in the UI or API may drop that list when
 * showing a plan to a user.
 */

export type EffectTemplateId = "subtle-punch" | "speaker-focus" | "hook-emphasis" | "clean-captions";

export const EFFECT_TEMPLATE_IDS: EffectTemplateId[] = [
  "subtle-punch",
  "speaker-focus",
  "hook-emphasis",
  "clean-captions",
];

export interface CutRange {
  startSec: number;
  endSec: number;
}

export interface ZoomKeyframe {
  tSec: number;
  /** Zoom scale relative to the base crop. 1 = no zoom. */
  scale: number;
}

export interface SubtitleStyle {
  /** Relative to the default caption font size. */
  fontSizeScale: number;
  primaryColorHex: string;
  /** Relative to the default bottom margin. */
  marginVerticalScale: number;
  emphasizeKeywords: boolean;
}

/**
 * An illustration laid over the clip for a while: a still image, placed
 * in the output frame, fading in and out.
 *
 * `assetId` is a reference, never a path or a URL. The bytes live in the
 * project's asset store (see lib/assets) and only the server ever turns
 * the id into a file — a plan arriving over the network therefore cannot
 * name a file on the machine, which is the whole reason overlays are
 * addressed this way.
 *
 * Times are clip-relative, like every other time in a RenderPlan. `rect`
 * is normalized to the *output* frame (1080x1920), not to the source:
 * where an illustration sits on the short has nothing to do with how the
 * speaker happened to be framed in the original.
 */
export interface Overlay {
  id: string;
  assetId: string;
  startSec: number;
  endSec: number;
  rect: NormalizedRect;
  /** 0..1; 1 is fully opaque. */
  opacity: number;
  /** Fade in and out, in seconds. 0 means a hard cut. */
  fadeSec: number;
}

export interface AudioDucking {
  enabled: boolean;
  /** Attenuation applied to background audio while speech is present, in dB (negative = quieter). */
  duckDb: number;
  attackSec: number;
  releaseSec: number;
}

export interface RenderPlan {
  templateId: EffectTemplateId;
  /** Overall effect strength in [0, 1]; drives how the other bounded fields were derived. */
  intensity: number;
  cuts: CutRange[];
  zoomKeyframes: ZoomKeyframe[];
  /** Illustrations laid over the clip, in no particular order. */
  overlays: Overlay[];
  subtitleStyle: SubtitleStyle;
  safeZones: SafeZone[];
  audioDucking: AudioDucking;
  limitations: string[];
}

// --- Bounds shared between the builder and the validator ---
export const INTENSITY_MIN = 0;
export const INTENSITY_MAX = 1;

export const ZOOM_SCALE_MIN = 1;
/**
 * A 35% punch-in: the ceiling short-form editing actually uses, and the
 * most the frame can take before a 1080p source starts to soften. The
 * previous 1.15 was imperceptible on a phone — the effect was declared,
 * validated and applied, and nobody could see it.
 *
 * The bound is what makes the zoom safe: the crop region shrinks to
 * 1/scale of the base crop and is then scaled back to 1080x1920, so a
 * higher ceiling would upscale a smaller and smaller patch of source.
 */
export const ZOOM_SCALE_MAX = 1.35;

export const MIN_CUT_DURATION_SEC = 0.2;

/**
 * Overlay bounds. Each extra overlay is an extra ffmpeg input and an
 * extra filter in the graph, so the count is capped — not for taste, but
 * because an unbounded list would let one clip build a filtergraph long
 * enough to exhaust the render.
 */
export const MAX_OVERLAYS_PER_PLAN = 8;
export const MIN_OVERLAY_DURATION_SEC = 0.3;
export const OVERLAY_OPACITY_MIN = 0.05;
export const OVERLAY_OPACITY_MAX = 1;
export const OVERLAY_FADE_SEC_MIN = 0;
export const OVERLAY_FADE_SEC_MAX = 1.5;
/** Smallest visible overlay, as a fraction of the output frame. */
export const OVERLAY_MIN_SIZE = 0.02;

export const FONT_SIZE_SCALE_MIN = 0.7;
export const FONT_SIZE_SCALE_MAX = 1.4;

export const MARGIN_SCALE_MIN = 0.5;
export const MARGIN_SCALE_MAX = 1.6;

export const DUCK_DB_MIN = -12;
export const DUCK_DB_MAX = 0;

export const ATTACK_SEC_MIN = 0.02;
export const ATTACK_SEC_MAX = 1;

export const RELEASE_SEC_MIN = 0.05;
export const RELEASE_SEC_MAX = 2;

export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
