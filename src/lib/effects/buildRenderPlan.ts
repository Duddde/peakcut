import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import type {
  AudioDucking,
  EffectTemplateId,
  PerspectiveMove,
  RenderPlan,
  SubtitleStyle,
  ZoomKeyframe,
} from "./types";
import {
  ATTACK_SEC_MIN,
  MIN_CUT_DURATION_SEC,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  RELEASE_SEC_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
} from "./types";

export interface BuildRenderPlanContext {
  segmentId: string;
  segmentDurationSec: number;
  /** Optional absolute-to-segment speaker-change timestamps (seconds), used by "speaker-focus". */
  speakerChangeTimesSec?: number[];
}

const DUCKING_LIMITATION =
  "Le ducking audio est déclaré et validé dans le plan, mais n'est pas encore appliqué au mixage audio par l'export dans ce MVP.";
const CUTS_LIMITATION =
  "Aucune détection automatique de coupes n'est effectuée : le plan couvre toujours l'intégralité du segment.";

/**
 * What a plan still does not do. The zoom used to be listed here, and so
 * were the 3D effects; neither is any more, because exportSegment
 * compiles the keyframes into a real animated ffmpeg crop and the 3D
 * moves into a real animated `perspective`. When it cannot (no base crop,
 * a plan that fails validation), it says so itself, per export, in
 * `renderLimitations` — a limitation that depends on the call does not
 * belong in a constant.
 */
export const COMMON_LIMITATIONS = [DUCKING_LIMITATION, CUTS_LIMITATION];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noDucking(): AudioDucking {
  return { enabled: false, duckDb: 0, attackSec: ATTACK_SEC_MIN, releaseSec: RELEASE_SEC_MIN };
}

interface TemplateOutput {
  intensity: number;
  zoomKeyframes: ZoomKeyframe[];
  /**
   * 3D moves the template puts in by itself. Only "hook-emphasis" does:
   * its whole job is an opening that cannot be scrolled past, and a frame
   * that drops into place is exactly that. The other three stay flat on
   * purpose — a tilt on every clip would read as a filter applied to the
   * batch rather than as an edit, and the studio's 3D panel is there for
   * whoever wants more.
   */
  perspectiveMoves: PerspectiveMove[];
  subtitleStyle: SubtitleStyle;
  audioDucking: AudioDucking;
}

/**
 * The opening tilt of "hook-emphasis": the frame starts rotated and lands
 * flat over the first instants of the clip, while the zoom punches in.
 *
 * The direction is fixed rather than varied per clip, because a plan has
 * to be reproducible — the same clip and the same template must give the
 * same export, and a tilt that alternated would make two renders of one
 * clip differ for no reason the user asked for.
 */
function hookPerspectiveMoves(durationSec: number): PerspectiveMove[] {
  const endSec = Math.min(0.6, durationSec);
  if (endSec < MIN_PERSPECTIVE_MOVE_DURATION_SEC) return [];
  return [{ id: "hook-settle", startSec: 0, endSec, direction: "left", profile: "settle", amount: 0.8 }];
}

function buildSubtlePunch(durationSec: number): TemplateOutput {
  const zoomKeyframes: ZoomKeyframe[] =
    durationSec > 0
      ? [
          { tSec: 0, scale: ZOOM_SCALE_MIN },
          { tSec: durationSec / 2, scale: clamp(1.12, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX) },
          { tSec: durationSec, scale: ZOOM_SCALE_MIN },
        ]
      : [{ tSec: 0, scale: ZOOM_SCALE_MIN }];

  return {
    intensity: 0.35,
    zoomKeyframes,
    perspectiveMoves: [],
    subtitleStyle: {
      fontSizeScale: 1.0,
      primaryColorHex: "#FFFFFF",
      marginVerticalScale: 1.0,
      emphasizeKeywords: false,
    },
    audioDucking: noDucking(),
  };
}

function buildSpeakerFocus(durationSec: number, speakerChangeTimesSec?: number[]): TemplateOutput {
  let zoomKeyframes: ZoomKeyframe[];
  if (durationSec <= 0) {
    zoomKeyframes = [{ tSec: 0, scale: ZOOM_SCALE_MIN }];
  } else if (speakerChangeTimesSec && speakerChangeTimesSec.length > 0) {
    const punchScale = clamp(1.2, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX);
    const changeKeyframes = speakerChangeTimesSec.map((t) => ({
      tSec: clamp(t, 0, durationSec),
      scale: punchScale,
    }));
    zoomKeyframes = [{ tSec: 0, scale: ZOOM_SCALE_MIN }, ...changeKeyframes].sort(
      (a, b) => a.tSec - b.tSec
    );
  } else {
    zoomKeyframes = [{ tSec: 0, scale: clamp(1.15, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX) }];
  }

  return {
    intensity: 0.5,
    zoomKeyframes,
    perspectiveMoves: [],
    subtitleStyle: {
      fontSizeScale: 1.05,
      primaryColorHex: "#FFFFFF",
      marginVerticalScale: 1.0,
      emphasizeKeywords: false,
    },
    audioDucking: { enabled: true, duckDb: -6, attackSec: 0.08, releaseSec: 0.4 },
  };
}

function buildHookEmphasis(durationSec: number): TemplateOutput {
  const zoomKeyframes: ZoomKeyframe[] =
    durationSec > 0
      ? [
          { tSec: 0, scale: ZOOM_SCALE_MIN },
          { tSec: Math.min(0.6, durationSec), scale: ZOOM_SCALE_MAX },
          { tSec: durationSec, scale: ZOOM_SCALE_MAX },
        ]
      : [{ tSec: 0, scale: ZOOM_SCALE_MIN }];

  return {
    intensity: 0.7,
    zoomKeyframes,
    perspectiveMoves: hookPerspectiveMoves(durationSec),
    subtitleStyle: {
      fontSizeScale: 1.25,
      primaryColorHex: "#FFD24D",
      marginVerticalScale: 1.1,
      emphasizeKeywords: true,
    },
    audioDucking: noDucking(),
  };
}

function buildCleanCaptions(_durationSec: number): TemplateOutput {
  return {
    intensity: 0.15,
    zoomKeyframes: [{ tSec: 0, scale: ZOOM_SCALE_MIN }],
    perspectiveMoves: [],
    subtitleStyle: {
      fontSizeScale: 1.0,
      primaryColorHex: "#FFFFFF",
      marginVerticalScale: 0.8,
      emphasizeKeywords: false,
    },
    audioDucking: noDucking(),
  };
}

/**
 * Builds a fully-bounded, deterministic RenderPlan for one of the four
 * effect templates. Nothing here is randomized and nothing exceeds the
 * bounds declared in ./types — see validateRenderPlan for the
 * independently-checkable version of those same bounds.
 */
export function buildRenderPlan(templateId: EffectTemplateId, context: BuildRenderPlanContext): RenderPlan {
  const durationSec = Math.max(0, context.segmentDurationSec);

  let output: TemplateOutput;
  switch (templateId) {
    case "subtle-punch":
      output = buildSubtlePunch(durationSec);
      break;
    case "speaker-focus":
      output = buildSpeakerFocus(durationSec, context.speakerChangeTimesSec);
      break;
    case "hook-emphasis":
      output = buildHookEmphasis(durationSec);
      break;
    case "clean-captions":
      output = buildCleanCaptions(durationSec);
      break;
    default:
      throw new Error(`Modèle d'effet inconnu : "${templateId}".`);
  }

  /**
   * A clip shorter than the shortest legal cut cannot carry an edit: a
   * zero-length cut, or one below MIN_CUT_DURATION_SEC, is exactly what
   * validateRenderPlan rejects. Rather than emit a plan that fails its
   * own validator — and have the export silently fall back — the plan
   * degrades to "no cut, no zoom", which is valid and true.
   */
  const tooShortToEdit = durationSec < MIN_CUT_DURATION_SEC;

  return {
    templateId,
    intensity: output.intensity,
    cuts: tooShortToEdit ? [] : [{ startSec: 0, endSec: durationSec }],
    // No template invents an illustration: there is no image to show
    // until the user adds or generates one (see lib/assets).
    overlays: [],
    // Nor does a template invent a framing: which face to follow is a
    // fact about the video, read off a real detection by the tracking
    // job (see lib/tracking/buildSpeakerFraming), never a guess made
    // from the transcript alone. No shots means the clip keeps the
    // single crop its variant already carries.
    framing: [],
    // A clip too short to carry a cut is too short to carry a camera
    // move: the window would fall outside the plan's own cut range, which
    // is what validateRenderPlan refuses.
    perspectiveMoves: tooShortToEdit ? [] : output.perspectiveMoves,
    zoomKeyframes: tooShortToEdit ? [{ tSec: 0, scale: ZOOM_SCALE_MIN }] : output.zoomKeyframes,
    subtitleStyle: output.subtitleStyle,
    safeZones: buildDefaultSafeZones(context.segmentId),
    audioDucking: output.audioDucking,
    limitations: COMMON_LIMITATIONS,
  };
}
