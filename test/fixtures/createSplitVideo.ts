import { spawn } from "node:child_process";

/**
 * A synthetic source split down a known vertical line: white from the
 * left edge to `whiteWidthPx` of 1280, black from there on, with a sine
 * tone for audio. Built from ffmpeg's own lavfi sources, like every other
 * fixture here — no binary is committed to the repo.
 *
 * It exists so that "the frame moved" can be measured with nothing but
 * average brightness: a 9:16 window in a 16:9 frame is 405px wide, so
 * with the split at 450px a crop pinned to the left edge sits entirely in
 * the white half and a crop pinned to the right edge entirely in the
 * black one. Colour bars would make a prettier fixture and prove nothing
 * about where the crop is.
 */
export function createSplitVideo(
  outputPath: string,
  durationSec: number,
  whiteWidthPx = 450
): Promise<void> {
  const blackWidthPx = 1280 - whiteWidthPx;
  const args = [
    "-y",
    "-f", "lavfi", "-i", `color=c=white:s=${whiteWidthPx}x720:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `color=c=black:s=${blackWidthPx}x720:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
    "-map", "[v]",
    "-map", "2:a",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Échec de génération du fixture coupé en deux (code ${code}):\n${stderr.slice(-2000)}`));
    });
  });
}

/** The 9:16 window of a 16:9 frame, as a fraction of its width: 0.5625 / (16/9). */
export const VERTICAL_WINDOW_WIDTH = 0.31640625;
