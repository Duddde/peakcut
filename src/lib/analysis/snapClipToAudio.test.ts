import { describe, expect, it } from "vitest";
import { snapClipToAudio } from "./snapClipToAudio";
import { quietestMoment, type AudioEnvelope, type ReadAudioEnvelope } from "@/lib/ffmpeg/audioEnvelope";

/** An envelope of the source in 20 ms frames: loud everywhere except the given quiet stretches. */
function fakeAudio(quiet: Array<[number, number]>): ReadAudioEnvelope {
  return async (_path, startSec, durationSec, frameSec) => {
    const levels: number[] = [];
    for (let t = startSec; t < startSec + durationSec - 1e-9; t += frameSec) {
      const middle = t + frameSec / 2;
      levels.push(quiet.some(([a, b]) => middle >= a && middle <= b) ? 0.01 : 0.3);
    }
    return { startSec, frameSec, levels };
  };
}

describe("snapClipToAudio", () => {
  it("moves an end that clips the last word onto the pause after it", async () => {
    // The transcript says the clip ends at 60.0; the voice actually stops at 60.4.
    const bounds = await snapClipToAudio("m.mp4", { startSec: 10, endSec: 60 }, fakeAudio([[9.6, 9.95], [60.4, 60.7]]), 120);
    expect(bounds.endSec).toBeGreaterThan(60.4);
    expect(bounds.endSec).toBeLessThan(60.7);
    expect(bounds.startSec).toBeGreaterThan(9.6);
    expect(bounds.startSec).toBeLessThanOrEqual(10);
  });

  it("never moves the start forward, past the first word", async () => {
    const bounds = await snapClipToAudio("m.mp4", { startSec: 10, endSec: 60 }, fakeAudio([[10.05, 10.3]]), 120);
    expect(bounds.startSec).toBeLessThanOrEqual(10);
  });

  it("does not run past the end of the source", async () => {
    const bounds = await snapClipToAudio("m.mp4", { startSec: 10, endSec: 59.9 }, fakeAudio([]), 60);
    expect(bounds.endSec).toBeLessThanOrEqual(60);
  });
});

describe("quietestMoment", () => {
  it("prefers, among equally quiet moments, the one nearest the requested time", () => {
    const envelope: AudioEnvelope = { startSec: 0, frameSec: 0.1, levels: [0.3, 0.3, 0.01, 0.3, 0.3, 0.3, 0.01, 0.01, 0.3, 0.3] };
    expect(quietestMoment(envelope, 0, 1, 0.7)).toBeCloseTo(0.65, 2);
  });
});
