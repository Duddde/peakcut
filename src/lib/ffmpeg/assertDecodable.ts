import { spawn } from "node:child_process";

export class NotDecodableError extends Error {
  constructor(filePath: string, stderr: string) {
    super(`Le fichier "${filePath}" n'a pas pu être décodé intégralement par ffmpeg : ${stderr.slice(-2000)}`);
    this.name = "NotDecodableError";
  }
}

/**
 * Decodes a media file fully (discarding the output) to prove it is
 * genuinely readable end to end — not just structurally probeable via
 * ffprobe's container metadata. Real subprocess call, no mock.
 */
export function assertDecodable(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", filePath, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stderr.trim().length === 0) {
        resolve();
      } else {
        reject(new NotDecodableError(filePath, stderr));
      }
    });
  });
}
