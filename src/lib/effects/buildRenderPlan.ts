import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import type {
  AudioDucking,
  EffectTemplateId,
  RenderPlan,
  SubtitleStyle,
  ZoomKeyframe,
} from "./types";
import { ATTACK_SEC_MIN, RELEASE_SEC_MIN, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN } from "./types";

export interface BuildRenderPlanContext {
  segmentId: string;
  segmentDurationSec: number;
  /** Optional absolute-to-segment speaker-change timestamps (seconds), used by "speaker-focus". */
  speakerChangeTimesSec?: number[];
}

const ZOOM_LIMITATION =
  "Les images clés de zoom sont validées et prévisualisables, mais l'export actuel applique un cadrage statique borné plutôt qu'une animation de zoom image par image.";
const DUCKING_LIMITATION =
  "Le ducking audio est déclaré et validé dans le plan, mais n'est pas encore appliqué au mixage audio par l'export dans ce MVP.";
const CUTS_LIMITATION =
  "Aucune détection automatique de coupes n'est effectuée : le plan couvre toujours l'intégralité du segment.";

const COMMON_LIMITATIONS = [ZOOM_LIMITATION, DUCKING_LIMITATION, CUTS_LIMITATION];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noDucking(): AudioDucking {
  return { enabled: false, duckDb: 0, attackSec: ATTACK_SEC_MIN, releaseSec: RELEASE_SEC_MIN };
}

interface TemplateOutput {
  intensity: number;
  zoomKeyframes: ZoomKeyframe[];
  subtitleStyle: SubtitleStyle;
  audioDucking: AudioDucking;
}

function buildSubtlePunch(durationSec: number): TemplateOutput {
  const zoomKeyframes: ZoomKeyframe[] =
    durationSec > 0
      ? [
          { tSec: 0, scale: ZOOM_SCALE_MIN },
          { tSec: durationSec / 2, scale: clamp(1.06, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX) },
          { tSec: durationSec, scale: ZOOM_SCALE_MIN },
        ]
      : [{ tSec: 0, scale: ZOOM_SCALE_MIN }];

  return {
    intensity: 0.35,
    zoomKeyframes,
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
    const punchScale = clamp(1.1, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX);
    const changeKeyframes = speakerChangeTimesSec.map((t) => ({
      tSec: clamp(t, 0, durationSec),
      scale: punchScale,
    }));
    zoomKeyframes = [{ tSec: 0, scale: ZOOM_SCALE_MIN }, ...changeKeyframes].sort(
      (a, b) => a.tSec - b.tSec
    );
  } else {
    zoomKeyframes = [{ tSec: 0, scale: clamp(1.08, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX) }];
  }

  return {
    intensity: 0.5,
    zoomKeyframes,
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

  return {
    templateId,
    intensity: output.intensity,
    cuts: [{ startSec: 0, endSec: durationSec }],
    zoomKeyframes: output.zoomKeyframes,
    subtitleStyle: output.subtitleStyle,
    safeZones: buildDefaultSafeZones(context.segmentId),
    audioDucking: output.audioDucking,
    limitations: COMMON_LIMITATIONS,
  };
}
