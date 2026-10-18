import { spawn } from "node:child_process";

/**
 * A synthetic source split across a known horizontal line: white from the
 * top edge down to `whiteHeightPx` of 720, black below. Built from
 * ffmpeg's own lavfi sources, like every other fixture here.
 *
 * It is the fixture for 3D moves, and the geometry is the whole point. A
 * tilt around the vertical axis pulls one *vertical* edge of the frame in
 * and leaves the other whole, so the near side shows less source stretched
 * over the full height — which moves the white/black line up on that side
 * and leaves it where it was on the other. Averaging the brightness of a
 * narrow column on each side therefore measures the tilt directly: equal
 * columns mean a flat frame, and a darker near column means the frame is
 * leaning. A 16:9 frame with a line at 180px of 720 puts that line at a
 * quarter of the height, far enough from the centre for the shift to be
 * unambiguous.
 */
export function createBandedVideo(
  outputPath: string,
  durationSec: number,
  whiteHeightPx = 180
): Promise<void> {
  const blackHeightPx = 720 - whiteHeightPx;
  const args = [
    "-y",
    "-f", "lavfi", "-i", `color=c=white:s=1280x${whiteHeightPx}:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `color=c=black:s=1280x${blackHeightPx}:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-filter_complex", "[0:v][1:v]vstack=inputs=2[v]",
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
      else reject(new Error(`Échec de génération du fixture en bandes (code ${code}):\n${stderr.slice(-2000)}`));
    });
  });
}

/** A narrow column at each side of the output frame, as normalized rectangles. */
export const LEFT_COLUMN = { x: 0.02, y: 0, width: 0.1, height: 1 };
export const RIGHT_COLUMN = { x: 0.88, y: 0, width: 0.1, height: 1 };
