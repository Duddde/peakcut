import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FfprobeStreamSummary {
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  durationSec: number;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { duration?: string };
}

/**
 * Runs the real `ffprobe` binary against an exported file and returns a
 * typed summary. This is a genuine subprocess call, not a mock — it is how
 * PeakCut proves an export actually meets the 1080x1920 / H.264 / AAC spec.
 */
export async function verifyExport(filePath: string): Promise<FfprobeStreamSummary> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams.find((s) => s.codec_type === "audio");

  return {
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    durationSec: parsed.format.duration ? Number(parsed.format.duration) : 0,
  };
}
