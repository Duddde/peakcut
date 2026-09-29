import { spawn } from "node:child_process";
import type { NormalizedRect } from "@/lib/domain/types";

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
}

export interface RenderPreviewSegmentResult {
  outputPath: string;
  durationSec: number;
}

function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
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
export async function renderPreviewSegment(input: RenderPreviewSegmentInput): Promise<RenderPreviewSegmentResult> {
  const { inputMediaPath, startSec, endSec, outputPath, crop } = input;
  if (!(endSec > startSec)) {
    throw new Error("endSec doit être strictement supérieur à startSec.");
  }
  const durationSec = endSec - startSec;
  if (durationSec > PREVIEW_MAX_DURATION_SEC) {
    throw new PreviewDurationExceededError(durationSec);
  }

  const watermark = `drawtext=text='${escapeDrawtext(PREVIEW_WATERMARK_TEXT)}':fontcolor=white@0.85:fontsize=28:box=1:boxcolor=black@0.45:boxborderw=10:x=(w-text_w)/2:y=h-th-40`;
  const videoFilter = `${cropFragment(crop)},scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT},setsar=1,${watermark}`;

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

  return { outputPath, durationSec };
}
