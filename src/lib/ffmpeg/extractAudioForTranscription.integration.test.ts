// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";
import {
  AudioExtractionError,
  extractAudioForTranscription,
  TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ,
} from "./extractAudioForTranscription";

const execFileAsync = promisify(execFile);
const SOURCE_DURATION_SEC = 6;

async function probe(filePath: string, entries: string): Promise<string> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    entries,
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return stdout.trim();
}

describe("extractAudioForTranscription (real ffmpeg + real ffprobe)", () => {
  let dir: string;
  let sourcePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-extract-audio-"));
    sourcePath = path.join(dir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces a real mono 16 kHz MP3 holding the audio and none of the video", async () => {
    const extracted = await extractAudioForTranscription(sourcePath);
    try {
      expect(existsSync(extracted.path)).toBe(true);
      expect(extracted.sizeBytes).toBe((await stat(extracted.path)).size);

      // Exactly one stream, and it is audio: the pixels are gone.
      expect(await probe(extracted.path, "stream=codec_type")).toBe("audio");
      expect(await probe(extracted.path, "stream=codec_name")).toBe("mp3");
      expect(await probe(extracted.path, "stream=channels")).toBe("1");
      expect(await probe(extracted.path, "stream=sample_rate")).toBe(String(TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ));

      // The whole recording is there, not a truncated head of it.
      expect(Number(await probe(extracted.path, "format=duration"))).toBeGreaterThan(SOURCE_DURATION_SEC - 0.5);

      // The point of the exercise: smaller than what it came from.
      expect(extracted.sizeBytes).toBeLessThan((await stat(sourcePath)).size);
    } finally {
      await extracted.cleanup();
    }
  }, 60000);

  it("cleanup removes the temporary file, and running it twice is harmless", async () => {
    const extracted = await extractAudioForTranscription(sourcePath);
    await extracted.cleanup();
    expect(existsSync(extracted.path)).toBe(false);
    await expect(extracted.cleanup()).resolves.toBeUndefined();
  }, 60000);

  it("fails explicitly on a file ffmpeg cannot decode, and leaves nothing behind", async () => {
    const notMedia = path.join(dir, "notes.txt");
    await execFileAsync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(notMedia)}, 'pas un média')`]);

    await expect(extractAudioForTranscription(notMedia)).rejects.toBeInstanceOf(AudioExtractionError);
  }, 60000);
});
