import { spawn } from "node:child_process";

/**
 * Average brightness of one frame of a finished clip, decoded to raw
 * 8-bit grey and averaged in JS. Crude on purpose: it needs no image
 * library, and it is enough to tell "a white picture is on screen here"
 * from "it is not" — which is all an overlay or a reframe has to prove.
 */
export function averageLuma(clipPath: string, atSec: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", atSec.toFixed(3),
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", "scale=64:64",
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const data = Buffer.concat(chunks);
      if (data.length === 0) {
        reject(new Error(`Aucune image décodée à t=${atSec}s dans ${clipPath}.`));
        return;
      }
      let total = 0;
      for (const byte of data) total += byte;
      resolve(total / data.length);
    });
  });
}
