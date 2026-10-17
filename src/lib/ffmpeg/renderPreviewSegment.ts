import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { NormalizedRect, TranscriptWord } from "@/lib/domain/types";
import { compileZoomFilter } from "@/lib/effects/compileZoomFilter";
import { compileOverlayFilters, type OverlayInput } from "@/lib/effects/compileOverlayFilters";
import { validateFilterGraph } from "@/lib/effects/validateFilterGraph";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import type { RenderPlan } from "@/lib/effects/types";
import { buildAssSubtitles } from "./buildAssSubtitles";

/**
 * Free, anonymous-tier preview: deliberately lower resolution and bitrate
 * than a real export (see exportSpec.ts's 1080x1920), and always
 * burned-in with a visible "PeakCut" watermark — this is a teaser, never a
 * substitute for the final download, which requires an account (see
 * /api/export-segment and AccountGate).
 */
export const PREVIEW_WIDTH = 540;
export const PREVIEW_HEIGHT = 960;
export const PREVIEW_MAX_DURATION_SEC = 20;
export const PREVIEW_WATERMARK_TEXT = "PeakCut \u00B7 Aper\u00E7u gratuit";

export class PreviewDurationExceededError extends Error {
  constructor(requestedSec: number) {
    super(
      `L'aperçu gratuit est limité à ${PREVIEW_MAX_DURATION_SEC}s (demandé : ${requestedSec.toFixed(1)}s).`
    );
    this.name = "PreviewDurationExceededError";
  }
}

export interface RenderPreviewSegmentInput {
  inputMediaPath: string;
  startSec: number;
  endSec: number;
  outputPath: string;
  /** Optional normalized crop rectangle in the source frame; defaults to a centered 9:16 crop, same convention as exportSegment. */
  crop?: NormalizedRect;
  /**
   * Absolute-timed transcript words. Given, the preview burns in the same
   * word-by-word captions as the export, at preview resolution.
   */
  words?: TranscriptWord[];
  /**
   * The segment's editing plan. Given with a base crop, the preview
   * animates the same zoom and uses the same caption style the export
   * will — which is the point of a preview: it has to show the edit being
   * edited, not a bare crop of the source.
   */
  renderPlan?: RenderPlan;
  /**
   * Local file of each illustration the plan refers to, by asset id —
   * same contract as exportSegment: resolved by the caller, and an
   * illustration whose image is absent is simply not shown. A preview
   * must show the same edit the export will, illustrations included.
   */
  overlayFiles?: Record<string, string>;
}

export interface RenderPreviewSegmentResult {
  outputPath: string;
  durationSec: number;
  /** Written only when captions were burned in; the caller owns cleanup, as with exportSegment. */
  assPath: string | null;
  /** What of the plan actually made it into this preview. */
  renderApplied: { zoom: boolean; subtitles: boolean; overlays: number };
}

function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Candidate fonts for the watermark, by platform, most-standard first.
 *
 * `drawtext` without an explicit `fontfile` asks fontconfig for a default
 * font. That works on a properly configured Linux box, but on a Windows
 * ffmpeg build with no fontconfig configuration it prints "Cannot load
 * default config file" and then **segfaults** (exit 3221225477 / SIGSEGV),
 * so no preview could ever be produced there. Naming a real file keeps
 * fontconfig out of the picture entirely.
 */
const WATERMARK_FONT_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/tahoma.ttf",
    "C:/Windows/Fonts/verdana.ttf",
  ],
  darwin: [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ],
  linux: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  ],
};

export interface ResolveWatermarkFontOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Injected in tests; defaults to a real filesystem check. */
  fileExists?: (path: string) => boolean;
}

/**
 * The font file passed to `drawtext`, or null to let ffmpeg resolve one
 * through fontconfig (the right answer on a machine where that works).
 * `PEAKCUT_WATERMARK_FONT` overrides everything — it holds a path, never
 * a secret.
 */
export function resolveWatermarkFont(options: ResolveWatermarkFontOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;

  const configured = env.PEAKCUT_WATERMARK_FONT?.trim();
  if (configured) return fileExists(configured) ? configured : null;

  const candidates = WATERMARK_FONT_CANDIDATES[platform] ?? WATERMARK_FONT_CANDIDATES.linux;
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

/**
 * A path inside an ffmpeg filter argument: a Windows drive letter's colon
 * would otherwise be read as the separator between filter options.
 * Backslashes become forward slashes first — ffmpeg accepts those on
 * Windows, and it avoids a second level of escaping.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * The `fontfile='…':` prefix for a `drawtext` filter, or "" when ffmpeg
 * should fall back to fontconfig. Shared with /api/preview-segment, which
 * builds its own ffmpeg command and would segfault the same way.
 */
export function drawtextFontFragment(options: ResolveWatermarkFontOptions = {}): string {
  const fontFile = resolveWatermarkFont(options);
  return fontFile ? `fontfile='${escapeFilterPath(fontFile)}':` : "";
}

function cropFragment(crop?: NormalizedRect): string {
  return crop
    ? `crop=w=iw*${crop.width}:h=ih*${crop.height}:x=iw*${crop.x}:y=ih*${crop.y}`
    : `scale=-2:${PREVIEW_HEIGHT},crop=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}`;
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
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (aperçu) a échoué avec le code ${code}:\n${stderr.slice(-4000)}`));
    });
  });
}

/**
 * Generates a low-resolution, watermarked MP4 preview via real ffmpeg —
 * there is no mock/fake path here; a failure throws rather than ever
 * writing (or claiming to have written) a file that doesn't actually exist.
 */
/**
 * The crop(+zoom) fragment for a preview, falling back to the plain
 * static crop whenever there is nothing safe to animate — no plan, no
 * base crop, a plan that fails its bounds, or a fragment the independent
 * filtergraph check rejects. Same rule as exportSegment: a preview never
 * renders an effect the export would refuse.
 */
function previewCropFragment(
  crop: NormalizedRect | undefined,
  renderPlan: RenderPlan | undefined
): { fragment: string; zoomApplied: boolean } {
  if (!renderPlan || !crop || !validateRenderPlan(renderPlan).ok) {
    return { fragment: cropFragment(crop), zoomApplied: false };
  }
  const compiled = compileZoomFilter({ baseCrop: crop, zoomKeyframes: renderPlan.zoomKeyframes });
  const candidate = `${compiled.filterFragment},scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}`;
  if (!validateFilterGraph(candidate).ok) {
    return { fragment: cropFragment(crop), zoomApplied: false };
  }
  return { fragment: compiled.filterFragment, zoomApplied: compiled.zoomApplied };
}

/**
 * The preview's illustrations, compiled exactly as the export compiles
 * them — only at preview resolution. With none to composite, the command
 * keeps its single input and its `-vf` chain; with any, the chain moves
 * into a `-filter_complex` graph and the streams are mapped explicitly.
 */
function previewOverlayArgs(
  videoFilter: string,
  renderPlan: RenderPlan | undefined,
  overlayFiles: Record<string, string> | undefined
): { inputArgs: string[]; filterArgs: string[]; appliedCount: number } {
  const noOverlays = { inputArgs: [], filterArgs: ["-vf", videoFilter], appliedCount: 0 };
  if (!renderPlan || renderPlan.overlays.length === 0) return noOverlays;

  const inputs: OverlayInput[] = [];
  for (const overlay of renderPlan.overlays) {
    const filePath = overlayFiles?.[overlay.assetId];
    if (filePath) inputs.push({ overlay, filePath });
  }
  if (inputs.length === 0) return noOverlays;

  const compiled = compileOverlayFilters({
    overlays: inputs,
    outputWidth: PREVIEW_WIDTH,
    outputHeight: PREVIEW_HEIGHT,
    baseLabel: "vbase",
    firstInputIndex: 1,
  });
  if (!compiled.chain || !validateFilterGraph(compiled.chain).ok) return noOverlays;

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
  };
}

export async function renderPreviewSegment(input: RenderPreviewSegmentInput): Promise<RenderPreviewSegmentResult> {
  const { inputMediaPath, startSec, endSec, outputPath, crop, words, renderPlan, overlayFiles } = input;
  if (!(endSec > startSec)) {
    throw new Error("endSec doit être strictement supérieur à startSec.");
  }
  const durationSec = endSec - startSec;
  if (durationSec > PREVIEW_MAX_DURATION_SEC) {
    throw new PreviewDurationExceededError(durationSec);
  }

  const planIsValid = Boolean(renderPlan) && validateRenderPlan(renderPlan!).ok;
  const segmentWords = (words ?? []).filter((w) => w.startSec >= startSec && w.startSec < endSec);

  let assPath: string | null = null;
  if (segmentWords.length > 0) {
    assPath = outputPath.replace(/\.[^.]+$/, "") + ".ass";
    await writeFile(
      assPath,
      buildAssSubtitles(segmentWords, {
        videoWidth: PREVIEW_WIDTH,
        videoHeight: PREVIEW_HEIGHT,
        baseOffsetSec: startSec,
        ...(planIsValid && renderPlan
          ? {
              fontSizeScale: renderPlan.subtitleStyle.fontSizeScale,
              primaryColorHex: renderPlan.subtitleStyle.primaryColorHex,
              marginVerticalScale: renderPlan.subtitleStyle.marginVerticalScale,
              emphasizeKeywords: renderPlan.subtitleStyle.emphasizeKeywords,
            }
          : {}),
      }),
      "utf-8"
    );
  }

  const resolvedCrop = previewCropFragment(crop, planIsValid ? renderPlan : undefined);
  const watermark = `drawtext=${drawtextFontFragment()}text='${escapeDrawtext(PREVIEW_WATERMARK_TEXT)}':fontcolor=white@0.85:fontsize=28:box=1:boxcolor=black@0.45:boxborderw=10:x=(w-text_w)/2:y=h-th-40`;
  const subtitles = assPath ? `ass='${escapeFilterPath(assPath)}',` : "";
  const videoFilter = `${resolvedCrop.fragment},scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT},setsar=1,${subtitles}${watermark}`;

  const overlays = previewOverlayArgs(videoFilter, planIsValid ? renderPlan : undefined, overlayFiles);

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
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await runFfmpeg(args);

  return {
    outputPath,
    durationSec,
    assPath,
    renderApplied: {
      zoom: resolvedCrop.zoomApplied,
      subtitles: assPath !== null,
      overlays: overlays.appliedCount,
    },
  };
}
