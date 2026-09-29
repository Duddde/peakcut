import { spawn } from "node:child_process";

/**
 * Generates a short synthetic H.264/AAC test video (color bars + a sine
 * tone) purely from ffmpeg's built-in lavfi sources — no binary fixture is
 * committed to the repo. Used as the "local media" input for real,
 * end-to-end ffmpeg export tests.
 */
export function createSyntheticVideo(outputPath: string, durationSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=1280x720:rate=30:duration=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      outputPath,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Échec de génération du fixture synthétique (code ${code}):\n${stderr.slice(-2000)}`));
    });
  });
}
