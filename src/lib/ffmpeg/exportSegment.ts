import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { NormalizedRect, TranscriptWord } from "@/lib/domain/types";
import { buildAssSubtitles } from "./buildAssSubtitles";
import { EXPORT_WIDTH, EXPORT_HEIGHT } from "./exportSpec";
import { compileZoomFilter } from "@/lib/effects/compileZoomFilter";
import { compilePerspectiveFilter } from "@/lib/effects/compilePerspectiveFilter";
import { compileOverlayFilters, type OverlayInput } from "@/lib/effects/compileOverlayFilters";
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
  /**
   * Local file of each illustration the plan refers to, by asset id —
   * resolved by the caller, which is the only layer that knows the
   * project and may read its asset store (see lib/assets). An overlay
   * whose asset is absent here is skipped and reported in
   * `renderLimitations`; the clip still exports.
   */
  overlayFiles?: Record<string, string>;
}

export interface RenderApplied {
  zoom: boolean;
  subtitleStyle: boolean;
  ducking: boolean;
  /** How many of the plan's illustrations were actually composited. */
  overlays: number;
  /** How many framing shots actually moved the crop; 0 means one static framing. */
  framing: number;
  /** How many 3D moves actually tilted the frame; 0 means a flat frame throughout. */
  perspective: number;
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
  framingApplied: number;
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
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: !crop,
      zoomApplied: false,
      framingApplied: 0,
      notes: [],
    };
  }

  const planCheck = validateRenderPlan(renderPlan);
  if (!planCheck.ok) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: !crop,
      zoomApplied: false,
      framingApplied: 0,
      notes: [`Plan de rendu invalide, cadrage statique de repli appliqué : ${planCheck.errors.join(" ")}`],
    };
  }

  if (!crop) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: true,
      zoomApplied: false,
      framingApplied: 0,
      notes: [
        renderPlan.framing.length > 0
          ? "Aucun cadrage (crop) de base fourni : le zoom animé et le suivi du locuteur nécessitent un cadrage explicite, cadrage statique par défaut appliqué à la place."
          : "Aucun cadrage (crop) de base fourni : le zoom animé du plan nécessite un cadrage explicite, cadrage statique par défaut appliqué à la place.",
      ],
    };
  }

  const compiled = compileZoomFilter({
    baseCrop: crop,
    zoomKeyframes: renderPlan.zoomKeyframes,
    // The shots that make the crop follow whoever is speaking; the same
    // single crop filter carries them and the zoom together.
    framing: renderPlan.framing,
  });
  const candidateFragment = `${compiled.filterFragment},scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`;
  const graphCheck = validateFilterGraph(candidateFragment);
  if (!graphCheck.ok) {
    return {
      cropFragment: staticCropOnlyFragment(crop),
      includesFinalScale: false,
      zoomApplied: false,
      framingApplied: 0,
      notes: [
        `Filtergraph de cadrage rejeté par la validation indépendante, cadrage statique de repli appliqué : ${graphCheck.errors.join(" ")}`,
      ],
    };
  }

  return {
    cropFragment: compiled.filterFragment,
    includesFinalScale: false,
    zoomApplied: compiled.zoomApplied,
    framingApplied: compiled.framingApplied,
    notes: compiled.notes,
  };
}

/**
 * The illustrations that can actually be rendered: those of a valid plan
 * whose asset the caller resolved to a real file. A missing file is a
 * note, never a failure — an export that refuses to run because one
 * illustration went missing would lose the whole clip over a decoration.
 */
function resolveOverlayInputs(
  renderPlan: RenderPlan | undefined,
  planIsValid: boolean,
  overlayFiles: Record<string, string> | undefined
): { inputs: OverlayInput[]; notes: string[] } {
  if (!renderPlan || !planIsValid || renderPlan.overlays.length === 0) {
    return { inputs: [], notes: [] };
  }

  const inputs: OverlayInput[] = [];
  const notes: string[] = [];
  for (const overlay of renderPlan.overlays) {
    const filePath = overlayFiles?.[overlay.assetId];
    if (!filePath) {
      notes.push(`Illustration "${overlay.id}" ignorée : son image est introuvable dans le projet.`);
      continue;
    }
    inputs.push({ overlay, filePath });
  }
  return { inputs, notes };
}

interface ResolvedPerspective {
  /** The fragment to splice into the chain, or null to leave the chain flat. */
  fragment: string | null;
  movesApplied: number;
  notes: string[];
}

/**
 * The 3D portion of the video filter.
 *
 * It is resolved apart from the crop because it does not need one: a
 * clip exported without an explicit crop still goes through the default
 * scale-then-crop, and tilting *that* frame is just as valid. The
 * compiled fragment is handed to the independent filtergraph validator
 * before use, like every other compiled fragment here, and a fragment
 * that fails it is dropped — the clip then exports flat, and says so.
 */
function resolvePerspectiveFilter(
  renderPlan: RenderPlan | undefined,
  planIsValid: boolean
): ResolvedPerspective {
  if (!renderPlan || !planIsValid || renderPlan.perspectiveMoves.length === 0) {
    return { fragment: null, movesApplied: 0, notes: [] };
  }

  const compiled = compilePerspectiveFilter({ moves: renderPlan.perspectiveMoves });
  if (!compiled.filterFragment) {
    return { fragment: null, movesApplied: 0, notes: compiled.notes };
  }

  const graphCheck = validateFilterGraph(compiled.filterFragment);
  if (!graphCheck.ok) {
    return {
      fragment: null,
      movesApplied: 0,
      notes: [
        ...compiled.notes,
        `Effets 3D rejetés par la validation indépendante du filtergraph, image plate conservée : ${graphCheck.errors.join(" ")}`,
      ],
    };
  }

  return { fragment: compiled.filterFragment, movesApplied: compiled.movesApplied, notes: compiled.notes };
}

/**
 * The 3D tilt runs after the crop and the scale, and before the
 * subtitles: it is a camera move on the finished frame, so the captions
 * have to stay flat and readable on top of it rather than tilt with it.
 */
function buildVideoFilter(
  assPath: string,
  resolved: ResolvedVideoFilter,
  perspectiveFragment: string | null
): string {
  const cropAndScale = resolved.includesFinalScale
    ? resolved.cropFragment
    : `${resolved.cropFragment},scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`;
  const perspective = perspectiveFragment ? `${perspectiveFragment},` : "";
  const escapedAssPath = escapeFfmpegFilterPath(assPath);
  return `${cropAndScale},${perspective}setsar=1,ass='${escapedAssPath}'`;
}

interface OverlayArgs {
  /** Extra `-i` groups for the illustration images, in input order. */
  inputArgs: string[];
  /** Either `["-vf", filter]` (no illustration) or `["-filter_complex", graph, "-map", …]`. */
  filterArgs: string[];
  appliedCount: number;
  notes: string[];
}

/**
 * Chooses between the two shapes an export can take.
 *
 * With no illustration to composite, the command is exactly what it has
 * always been: a single input and a `-vf` chain. One extra image means
 * extra inputs, which `-vf` cannot address, so the same chain is moved
 * into a `-filter_complex` graph and the streams are mapped explicitly —
 * `0:a?` because a source without an audio track must still export.
 *
 * The compiled overlay chain is re-checked by the independent filtergraph
 * validator before it is used, and a chain that fails it is dropped: the
 * clip then exports without its illustrations, and says so, rather than
 * handing ffmpeg a graph nobody vouched for. Only the overlay part is
 * checked — the crop fragment has already been validated on its own, and
 * the subtitle file's path is deliberately left out of that check, since
 * an escaped Windows path contains backslashes the validator refuses by
 * design.
 */
function buildOverlayArgs(
  videoFilter: string,
  renderPlan: RenderPlan | undefined,
  planIsValid: boolean,
  overlayFiles: Record<string, string> | undefined
): OverlayArgs {
  const resolved = resolveOverlayInputs(renderPlan, planIsValid, overlayFiles);
  const noOverlays: OverlayArgs = {
    inputArgs: [],
    filterArgs: ["-vf", videoFilter],
    appliedCount: 0,
    notes: resolved.notes,
  };
  if (resolved.inputs.length === 0) return noOverlays;

  const compiled = compileOverlayFilters({
    overlays: resolved.inputs,
    outputWidth: EXPORT_WIDTH,
    outputHeight: EXPORT_HEIGHT,
    baseLabel: "vbase",
    firstInputIndex: 1,
  });
  if (!compiled.chain) {
    return { ...noOverlays, notes: [...resolved.notes, ...compiled.notes] };
  }

  const graphCheck = validateFilterGraph(compiled.chain);
  if (!graphCheck.ok) {
    return {
      ...noOverlays,
      notes: [
        ...resolved.notes,
        `Illustrations rejetées par la validation indépendante du filtergraph : ${graphCheck.errors.join(" ")}`,
      ],
    };
  }

  return {
    inputArgs: compiled.inputArgs,
    filterArgs: [
      "-filter_complex",
      `[0:v]${videoFilter}[vbase];${compiled.chain}`,
      "-map",
      `[${compiled.outputLabel}]`,
      "-map",
      "0:a?",
    ],
    appliedCount: compiled.appliedCount,
    notes: [...resolved.notes, ...compiled.notes],
  };
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
          motionCards: renderPlan.motion ?? [],
        }
      : {}),
  });
  await writeFile(assPath, assContent, "utf-8");

  const resolvedPerspective = resolvePerspectiveFilter(renderPlan, planIsValid);
  const videoFilter = buildVideoFilter(assPath, resolvedCrop, resolvedPerspective.fragment);
  const overlays = buildOverlayArgs(videoFilter, renderPlan, planIsValid, input.overlayFiles);

  const renderApplied: RenderApplied = {
    zoom: resolvedCrop.zoomApplied,
    subtitleStyle: subtitleStyleApplied,
    ducking: false,
    overlays: overlays.appliedCount,
    framing: resolvedCrop.framingApplied,
    perspective: resolvedPerspective.movesApplied,
    templateId: renderPlan?.templateId ?? null,
  };
  const renderLimitations = [
    ...(renderPlan?.limitations ?? []),
    ...resolvedCrop.notes,
    ...resolvedPerspective.notes,
    ...overlays.notes,
  ];

  const args = [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-i",
    inputMediaPath,
    ...overlays.inputArgs,
    "-t",
    durationSec.toFixed(3),
    ...overlays.filterArgs,
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
