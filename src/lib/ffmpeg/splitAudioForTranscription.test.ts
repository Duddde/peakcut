// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseSilenceDetectLog,
  planTranscriptionChunks,
  probeMediaDurationSec,
  splitAudioForTranscription,
} from "./splitAudioForTranscription";

describe("planTranscriptionChunks", () => {
  it("keeps a recording within the limit in one piece", () => {
    expect(planTranscriptionChunks(1000, [], 1320)).toEqual([{ startSec: 0, endSec: 1000 }]);
  });

  it("cuts in the latest silence of the last quarter, never beyond the limit", () => {
    const silences = [
      { startSec: 500, endSec: 501 }, // too early: would make a short piece
      { startSec: 1100, endSec: 1101 },
      { startSec: 1250, endSec: 1252 },
      { startSec: 1330, endSec: 1331 }, // past the limit
    ];
    const plan = planTranscriptionChunks(2042.8, silences, 1320);
    expect(plan).toEqual([
      { startSec: 0, endSec: 1251 },
      { startSec: 1251, endSec: 2042.8 },
    ]);
  });

  it("cuts exactly at the limit when no silence is close enough", () => {
    const plan = planTranscriptionChunks(3000, [], 1320);
    expect(plan.map((c) => c.endSec - c.startSec)).toEqual([1320, 1320, 360]);
    expect(plan.every((c) => c.endSec - c.startSec <= 1320)).toBe(true);
  });
});

describe("parseSilenceDetectLog", () => {
  it("pairs each silence_start with the following silence_end", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.51",
      "size=N/A time=00:00:03.00",
      "[silencedetect @ 0x1] silence_start: 12.25",
      "[silencedetect @ 0x1] silence_end: 13 | silence_duration: 0.75",
      "[silencedetect @ 0x1] silence_start: 20", // runs to the end: no end reported
    ].join("\r\n");
    expect(parseSilenceDetectLog(log)).toEqual([
      { startSec: 0, endSec: 1.5 },
      { startSec: 12.25, endSec: 13 },
    ]);
  });
});

describe("splitAudioForTranscription (real ffmpeg)", () => {
  let dir: string;
  let audioPath: string;

  /** 4 s of tone, 1 s of silence, 3 s of tone. */
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-split-audio-"));
    audioPath = path.join(dir, "audio.mp3");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-filter_complex", "[0:a]aresample=16000,aformat=channel_layouts=mono[a];[2:a]aresample=16000,aformat=channel_layouts=mono[c];[a][1:a][c]concat=n=3:v=0:a=1",
        "-c:a", "libmp3lame", "-b:a", "64k",
        audioPath,
      ]);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
    });
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("cuts in the silence and writes pieces whose durations add up to the recording", async () => {
    const chunks = await splitAudioForTranscription(audioPath, 5);

    expect(chunks).toHaveLength(2);
    // The cut lands in the silence (4 s – 5 s), not at the 5 s limit.
    expect(chunks[0].endSec).toBeGreaterThan(4);
    expect(chunks[0].endSec).toBeLessThan(5);
    expect(chunks[1].startSec).toBe(chunks[0].endSec);
    for (const chunk of chunks) {
      expect(path.dirname(chunk.path)).toBe(dir);
      expect(await probeMediaDurationSec(chunk.path)).toBeCloseTo(chunk.endSec - chunk.startSec, 1);
    }
  }, 60000);
});
