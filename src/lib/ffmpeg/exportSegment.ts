import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { NormalizedRect, TranscriptWord } from "@/lib/domain/types";
import { buildAssSubtitles } from "./buildAssSubtitles";
import { EXPORT_WIDTH, EXPORT_HEIGHT } from "./exportSpec";
import { compileZoomFilter } from "@/lib/effects/compileZoomFilter";
import { validateFilterGraph } from "@/lib/effects/validateFilterGraph";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import type { RenderPlan } from "@/lib/effects/types";

export { EXPORT_WIDTH, EXPORT_HEIGHT };

export interface ExportSegmentInput {
  inputMediaPath: string;
  startSec: number;
  endSec: number;
  outputPath: string;
  /** Absolute-timed transcript words; only the ones within [startSec, endSec) are burned in. */
  words: TranscriptWord[];
  /** Optional normalized crop rectangle in the *source* frame. Defaults to a centered vertical crop. */
  crop?: NormalizedRect;
  /**
   * Optional declarative effect plan (see lib/effects). When present and
   * valid, its zoomKeyframes animate the given `crop` and its
   * subtitleStyle is applied to the burned-in ASS captions. When absent,
   * invalid (out of bounds), or lacking a base `crop` to animate, export
   * behavior is byte-for-byte the same as if no plan had been passed —
   * see `renderApplied`/`renderLimitations` on the result for exactly
   * what happened.
   */
  renderPlan?: RenderPlan;
}

export interface RenderApplied {
  zoom: boolean;
  subtitleStyle: boolean;
  ducking: boolean;
  templateId: string | null;
}

export interface ExportSegmentResult {
  outputPath: string;
  assPath: string;
  durationSec: number;
  renderApplied: RenderApplied;
  renderLimitations: string[];
}

function escapeFfmpegFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function staticCropOnlyFragment(crop?: NormalizedRect): string {
  return crop
    ? `crop=w=iw*${crop.width}:h=ih*${crop.height}:x=iw*${crop.x}:y=ih*${crop.y}`
    : `scale=-2:${EXPORT_HEIGHT},crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`;
}

interface ResolvedVideoFilter {
  cropFragment: string;
  /** True when the crop fragment already includes the final scale (the no-crop default path does its own scale-then-crop). */
  includesFinalScale: boolean;
  zoomApplied: boolean;
  notes: string[];
}

/**
 * Resolves the crop(+zoom) portion of the video filter. Falls back to the
 * exact previous static behavior whenever there is nothing safe to animate:
 * no plan, no crop to animate around, an out-of-bounds plan, or a
 * compiled filter fragment that fails independent validation.
 */
function resolveVideoCropFilter(crop: NormalizedRect | undefined, renderPlan: RenderPlan | undefined): ResolvedVideoFilter {
  if (!renderPlan) {
    return { cropFragment: staticCropOnlyFragment(crop), includesFinalScale: !crop, zoomApplied: false, notes: [] };
  }

  const planCheck = validateRenderPlan(renderPlan);
  if (!planCheck.ok) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: !crop,
      zoomApplied: false,
      notes: [`Plan de rendu invalide, cadrage statique de repli appliqué : ${planCheck.errors.join(" ")}`],
    };
  }

  if (!crop) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: true,
      zoomApplied: false,
      notes: [
        "Aucun cadrage (crop) de base fourni : le zoom animé du plan nécessite un cadrage explicite, cadrage statique par défaut appliqué à la place.",
      ],
    };
  }

  const compiled = compileZoomFilter({ baseCrop: crop, zoomKeyframes: renderPlan.zoomKeyframes });
  const candidateFragment = `${compiled.filterFragment},scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`;
  const graphCheck = validateFilterGraph(candidateFragment);
  if (!graphCheck.ok) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: false,
      zoomApplied: false,
      notes: [
        `Filtergraph de zoom rejeté par la validation indépendante, cadrage statique de repli appliqué : ${graphCheck.errors.join(" ")}`,
      ],
    };
  }

  return {
    cropFragment: compiled.filterFragment,
    includesFinalScale: false,
    zoomApplied: compiled.zoomApplied,
    notes: compiled.notes,
  };
}

function buildVideoFilter(assPath: string, resolved: ResolvedVideoFilter): string {
  const cropAndScale = resolved.includesFinalScale
    ? resolved.cropFragment
    : `${resolved.cropFragment},scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`;
  const escapedAssPath = escapeFfmpegFilterPath(assPath);
  return `${cropAndScale},setsar=1,ass='${escapedAssPath}'`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg a échoué avec le code ${code}:\n${stderr.slice(-4000)}`));
      }
    });
  });
}

/**
 * Exports a single vertical (1080x1920) H.264/AAC clip from a local media
 * file for a given [startSec, endSec) window, burning in word-by-word ASS
 * subtitles. This runs the real ffmpeg binary — there is no mock path here.
 */
export async function exportSegment(input: ExportSegmentInput): Promise<ExportSegmentResult> {
  const { inputMediaPath, startSec, endSec, outputPath, words, crop, renderPlan } = input;

  if (!(endSec > startSec)) {
    throw new Error("endSec doit être strictement supérieur à startSec.");
  }
  const durationSec = endSec - startSec;

  const resolvedCrop = resolveVideoCropFilter(crop, renderPlan);
  const planIsValid = !renderPlan || validateRenderPlan(renderPlan).ok;
  const subtitleStyleApplied = Boolean(renderPlan) && planIsValid;

  const assPath = outputPath.replace(/\.[^.]+$/, "") + ".ass";
  const segmentWords = words.filter((w) => w.startSec >= startSec && w.startSec < endSec);
  const assContent = buildAssSubtitles(segmentWords, {
    videoWidth: EXPORT_WIDTH,
    videoHeight: EXPORT_HEIGHT,
    baseOffsetSec: startSec,
    ...(subtitleStyleApplied && renderPlan
      ? {
          fontSizeScale: renderPlan.subtitleStyle.fontSizeScale,
          primaryColorHex: renderPlan.subtitleStyle.primaryColorHex,
          marginVerticalScale: renderPlan.subtitleStyle.marginVerticalScale,
          emphasizeKeywords: renderPlan.subtitleStyle.emphasizeKeywords,
        }
      : {}),
  });
  await writeFile(assPath, assContent, "utf-8");

  const videoFilter = buildVideoFilter(assPath, resolvedCrop);

  const renderApplied: RenderApplied = {
    zoom: resolvedCrop.zoomApplied,
    subtitleStyle: subtitleStyleApplied,
    ducking: false,
    templateId: renderPlan?.templateId ?? null,
  };
  const renderLimitations = [...(renderPlan?.limitations ?? []), ...resolvedCrop.notes];

  const args = [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-i",
    inputMediaPath,
    "-t",
    durationSec.toFixed(3),
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await runFfmpeg(args);

  return { outputPath, assPath, durationSec, renderApplied, renderLimitations };
}
