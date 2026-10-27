import type { NormalizedRect, SafeZone } from "@/lib/domain/types";
import type { MotionCard } from "@/lib/motion/types";

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

/**
 * One stretch of the clip framed on one place in the source: the shot.
 *
 * This is how a short follows the person who is speaking. A talking-head
 * crop that never moves is right for one voice and wrong for two: on an
 * exchange, the frame has to be on whoever is talking, and that means the
 * crop rectangle changes during the clip. A plan's `framing` is that
 * list of changes, as editable as everything else in a RenderPlan.
 *
 * `rect` is normalized to the *source* frame, like a variant's `crop` and
 * unlike an Overlay's rect — a shot says where to look in the original,
 * not where to put something on the short. Times are clip-relative.
 *
 * An empty `framing` means "keep the variant's static crop for the whole
 * clip", which is exactly what every plan did before shots existed.
 *
 * `transitionSec` is the pan from the previous shot's rectangle into this
 * one; 0 is a hard cut, which is what a speaker change normally wants -
 * a slow glide between two faces reads as a mistake, not as an effect.
 */
export interface FramingShot {
  id: string;
  startSec: number;
  endSec: number;
  rect: NormalizedRect;
  transitionSec: number;
  /**
   * Where this shot came from: an active speaker matched to a face, a
   * detected subject with no speaker attached, or the user's own hand.
   * Shown in the studio, so nobody mistakes a detection for a decision.
   */
  source: FramingShotSource;
  /** Short human label for the subject, e.g. "Intervenant A"; null when unknown. */
  label: string | null;
}

export type FramingShotSource = "speaker" | "subject" | "manual";

export const FRAMING_SHOT_SOURCES: FramingShotSource[] = ["speaker", "subject", "manual"];

/**
 * One stretch of the clip seen from a camera that moved in space: the 3D
 * move.
 *
 * This is the only effect here that is not a flat transform. `perspective`
 * maps a quadrilateral of the frame onto the output rectangle, so taking
 * a trapezoid instead of a rectangle shows the frame as a plane tilted
 * away from the viewer: the near edge covers less source blown up larger,
 * the far edge stays as it was. That is a real projective transform, not
 * a 2D squeeze faked to look like one — and because the quadrilateral is
 * always *inside* the frame, every output pixel comes from real source
 * pixels. No black wedge, no smeared edge, nothing invented.
 *
 * `direction` says which edge comes toward the viewer: "left" tilts the
 * plane so its left edge is nearest, "up" so its top edge is. `profile`
 * says how the tilt moves over the window — a swing that goes and comes
 * back, a settle that lands flat, a lift that tips away. Times are
 * clip-relative, like everything else in a RenderPlan, and outside its
 * window a move applies nothing at all.
 */
export interface PerspectiveMove {
  id: string;
  startSec: number;
  endSec: number;
  /** Which edge of the frame comes toward the viewer. */
  direction: PerspectiveDirection;
  /** How the tilt evolves across the window. */
  profile: PerspectiveProfile;
  /** Strength in [PERSPECTIVE_AMOUNT_MIN, PERSPECTIVE_AMOUNT_MAX]; scaled by PERSPECTIVE_INSET_MAX. */
  amount: number;
}

export type PerspectiveDirection = "left" | "right" | "up" | "down";
export type PerspectiveProfile = "swing" | "settle" | "lift";

export const PERSPECTIVE_DIRECTIONS: PerspectiveDirection[] = ["left", "right", "up", "down"];
export const PERSPECTIVE_PROFILES: PerspectiveProfile[] = ["swing", "settle", "lift"];

/**
 * The axis a direction tilts around. Two moves on the same axis cannot
 * overlap — the compiled expression resolves a frame to one tilt — but a
 * horizontal and a vertical move may run together, and they compose into
 * a diagonal tilt rather than fighting each other.
 */
export type PerspectiveAxis = "horizontal" | "vertical";

export function perspectiveAxisOf(direction: PerspectiveDirection): PerspectiveAxis {
  return direction === "left" || direction === "right" ? "horizontal" : "vertical";
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
  /** Shots the crop follows, in chronological order; empty = one static crop. */
  framing: FramingShot[];
  /** 3D moves applied over the clip, in chronological order; empty = a flat frame. */
  perspectiveMoves: PerspectiveMove[];
  /**
   * Claude Motion cards (see lib/motion): animated text illustrating what
   * is said. Optional so that every plan saved before them stays valid;
   * absent and empty mean the same thing.
   */
  motion?: MotionCard[];
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

/**
 * Framing bounds.
 *
 * The count is capped for a concrete reason: every shot adds a term to
 * the animated `crop` expression, and validateFilterGraph refuses a graph
 * over 8000 characters. An edited show changes angle every second or two,
 * so a 90-second clip framed on its camera cuts needs dozens of shots;
 * cut-only shots compile to one ~25-character step each (see
 * compileZoomFilter), and 120 of them stay well inside the limit. A plan
 * that went past the cap would compile into a filter nobody accepts and
 * fall back to a static crop — better to refuse the plan than to silently
 * render something else.
 */
export const MAX_FRAMING_SHOTS_PER_PLAN = 120;
/** Below this, a reframe reads as a glitch rather than as a cut. */
export const MIN_FRAMING_SHOT_DURATION_SEC = 0.4;
export const FRAMING_TRANSITION_SEC_MIN = 0;
export const FRAMING_TRANSITION_SEC_MAX = 1;
/** A crop window smaller than this would upscale a patch of source past recognition. */
export const FRAMING_MIN_SIZE = 0.05;
export const FRAMING_LABEL_MAX_LENGTH = 40;

/**
 * 3D move bounds.
 *
 * `PERSPECTIVE_INSET_MAX` is the ceiling that matters: it is the fraction
 * of the near edge the transform eats, so 0.22 means that edge shows 78%
 * of its source stretched over the full output — a 1.28x upscale, on top
 * of the roughly 1.8x the vertical crop already applies to a 1080p
 * source. Past that the near edge visibly softens, and a 3D effect whose
 * price is a blurry face is not worth having.
 *
 * The count is capped because each move adds a branch to the tilt
 * expression, and that expression is substituted into four of the
 * filter's eight corner coordinates — so the graph grows four times
 * faster than the list, against validateFilterGraph's 8000-character
 * ceiling.
 */
export const MAX_PERSPECTIVE_MOVES_PER_PLAN = 6;
/** Below this, a tilt reads as a glitch rather than as a camera move. */
export const MIN_PERSPECTIVE_MOVE_DURATION_SEC = 0.3;
export const PERSPECTIVE_AMOUNT_MIN = 0.05;
export const PERSPECTIVE_AMOUNT_MAX = 1;
export const PERSPECTIVE_INSET_MAX = 0.22;
/**
 * The frame rate the clip is conformed to before the 3D filter runs.
 *
 * ffmpeg's `perspective` is the one filter in the chain whose expressions
 * cannot read `t`: it only exposes the frame counter `on`. Rather than
 * guess the source's rate — and drift on a variable-frame-rate download,
 * which is most of YouTube — the chain pins the rate with an `fps` filter
 * right before it, so frame `on` is exactly `on / PERSPECTIVE_EVAL_FPS`
 * seconds into the clip. 30 is what short-form platforms deliver anyway;
 * the cost is that a clip carrying a 3D move exports at 30 fps, and a
 * clip carrying none is untouched.
 */
export const PERSPECTIVE_EVAL_FPS = 30;

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
