import type { SafeZone } from "@/lib/domain/types";

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
  subtitleStyle: SubtitleStyle;
  safeZones: SafeZone[];
  audioDucking: AudioDucking;
  limitations: string[];
}

// --- Bounds shared between the builder and the validator ---
export const INTENSITY_MIN = 0;
export const INTENSITY_MAX = 1;

export const ZOOM_SCALE_MIN = 1;
export const ZOOM_SCALE_MAX = 1.15;

export const MIN_CUT_DURATION_SEC = 0.2;

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
