import { spawn } from "node:child_process";

/** A rectangle of the frame, as fractions of its width and height. */
export interface LumaRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Average brightness of one frame of a finished clip — or of one region
 * of it — decoded to raw 8-bit grey and averaged in JS. Crude on purpose:
 * it needs no image library, and it is enough to tell "a white picture is
 * on screen here" from "it is not", which is all an overlay or a reframe
 * has to prove.
 *
 * The region matters for anything that deforms the frame rather than
 * moving it. A 3D tilt leaves the average brightness of the whole frame
 * almost unchanged while moving content on one side and not the other, so
 * it can only be measured by comparing two parts of the same image.
 */
export function averageLuma(clipPath: string, atSec: number, region?: LumaRegion): Promise<number> {
  const crop = region
    ? `crop=w=iw*${region.width}:h=ih*${region.height}:x=iw*${region.x}:y=ih*${region.y},`
    : "";
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", atSec.toFixed(3),
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", `${crop}scale=64:64`,
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
