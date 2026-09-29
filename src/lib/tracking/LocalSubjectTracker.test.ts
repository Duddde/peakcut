import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalSubjectTracker } from "./LocalSubjectTracker";
import { LocalMediaFileNotFoundError } from "@/lib/transcript/transcriptHttp";
import type { DetectedBoundingBox, SubjectDetectionEngine, SubjectDetectionInput } from "./types";

function fakeEngine(behavior: (input: SubjectDetectionInput) => Promise<DetectedBoundingBox[]>): SubjectDetectionEngine {
  return { id: "fake-engine", detect: behavior };
}

const BASE_INPUT = { sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 };

describe("LocalSubjectTracker", () => {
  let dir: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-local-subject-"));
    mediaPath = path.join(dir, "clip.mp4");
    await writeFile(mediaPath, "fake media bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("has a stable id and display name", () => {
    const tracker = new LocalSubjectTracker(fakeEngine(async () => []));
    expect(tracker.id).toBe("local-subject");
    expect(tracker.displayName).toBeTruthy();
  });

  it("throws when mediaPath is missing from the input", async () => {
    const tracker = new LocalSubjectTracker(fakeEngine(async () => []));
    await expect(tracker.track({ ...BASE_INPUT })).rejects.toThrow(/mediaPath/i);
  });

  it("throws LocalMediaFileNotFoundError for a nonexistent local file, without calling the engine", async () => {
    let called = false;
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => {
        called = true;
        return [];
      })
    );
    await expect(
      tracker.track({ ...BASE_INPUT, mediaPath: path.join(dir, "missing.mp4") })
    ).rejects.toBeInstanceOf(LocalMediaFileNotFoundError);
    expect(called).toBe(false);
  });

  it("falls back to a centered track (fallbackUsed: true) when the engine detects nothing", async () => {
    const tracker = new LocalSubjectTracker(fakeEngine(async () => []));
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    expect(track.fallbackUsed).toBe(true);
    expect(track.keyframes.every((k) => k.cx === 0.5 && k.cy === 0.5)).toBe(true);
    expect(track.keyframes.every((k) => k.confidence <= 0.4)).toBe(true);
  });

  it("reports fallbackUsed: false and uses the detector's own confidence when a real detection is received", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [{ tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.4, score: 0.9 }])
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    expect(track.fallbackUsed).toBe(false);
    expect(track.method).not.toContain("fallback");
    expect(track.keyframes[0].confidence).toBe(0.9);
  });

  it("propagates an engine error rather than silently falling back", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => {
        throw new Error("detection backend crashed");
      })
    );
    await expect(tracker.track({ ...BASE_INPUT, mediaPath })).rejects.toThrow(
      "detection backend crashed"
    );
  });

  it("converts a bounding box to its center (cx, cy)", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [{ tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.4, score: 0.9 }])
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    expect(track.keyframes[0].cx).toBeCloseTo(0.5, 5);
    expect(track.keyframes[0].cy).toBeCloseTo(0.5, 5);
  });

  it("clamps centers to [0, 1] even for a box extending past the frame edge", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [{ tSec: 0, x: 0.95, y: -0.1, width: 0.3, height: 0.3, score: 0.8 }])
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    expect(track.keyframes[0].cx).toBeLessThanOrEqual(1);
    expect(track.keyframes[0].cx).toBeGreaterThanOrEqual(0);
    expect(track.keyframes[0].cy).toBeLessThanOrEqual(1);
    expect(track.keyframes[0].cy).toBeGreaterThanOrEqual(0);
  });

  it("selects the main subject at each timestamp by score*area when multiple boxes are detected", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [
        // Small, low-confidence box (background extra) vs. a large, confident one (main subject).
        { tSec: 0, x: 0.05, y: 0.05, width: 0.05, height: 0.05, score: 0.5 },
        { tSec: 0, x: 0.4, y: 0.4, width: 0.3, height: 0.3, score: 0.9 },
      ])
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    // Main subject center: x+w/2=0.55, y+h/2=0.55
    expect(track.keyframes[0].cx).toBeCloseTo(0.55, 2);
    expect(track.keyframes[0].cy).toBeCloseTo(0.55, 2);
  });

  it("prefers continuity (staying near the previous pick) over a distant higher-score box", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [
        // t=0: only one subject, on the left.
        { tSec: 0, x: 0.05, y: 0.4, width: 0.2, height: 0.2, score: 0.8, trackId: "left-person" },
        // t=1: the same left person (slightly moved) plus a new, higher-score subject on the right.
        { tSec: 1, x: 0.08, y: 0.4, width: 0.2, height: 0.2, score: 0.75, trackId: "left-person" },
        { tSec: 1, x: 0.75, y: 0.4, width: 0.2, height: 0.2, score: 0.97, trackId: "right-newcomer" },
      ])
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    const second = track.keyframes.find((k) => k.tSec === 1)!;
    // Should stay with left-person (cx ~0.18) rather than jump to the newcomer (cx ~0.85).
    expect(second.cx).toBeLessThan(0.5);
  });

  it("smooths keyframe centers with a bounded moving-average window instead of raw jitter", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [
        { tSec: 0, x: 0.0, y: 0.4, width: 0.2, height: 0.2, score: 0.9, trackId: "p" },
        { tSec: 1, x: 0.8, y: 0.4, width: 0.2, height: 0.2, score: 0.9, trackId: "p" },
        { tSec: 2, x: 0.0, y: 0.4, width: 0.2, height: 0.2, score: 0.9, trackId: "p" },
      ]),
      { smoothingWindow: 3 }
    );
    const track = await tracker.track({ ...BASE_INPUT, mediaPath });
    const middle = track.keyframes.find((k) => k.tSec === 1)!;
    // Raw center at t=1 would be cx=0.9; smoothed against neighbors (cx=0.1) it must move toward them.
    expect(middle.cx).toBeLessThan(0.9);
    expect(middle.cx).toBeGreaterThan(0.1);
  });

  it("clamps an out-of-range smoothingWindow into a safe bound rather than erroring", async () => {
    const tracker = new LocalSubjectTracker(
      fakeEngine(async () => [{ tSec: 0, x: 0.4, y: 0.4, width: 0.2, height: 0.2, score: 0.9 }]),
      { smoothingWindow: 999 }
    );
    await expect(tracker.track({ ...BASE_INPUT, mediaPath })).resolves.toBeDefined();
  });

  it("is deterministic across calls with the same engine output", async () => {
    const engine = fakeEngine(async () => [
      { tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.4, score: 0.9 },
      { tSec: 1, x: 0.42, y: 0.31, width: 0.2, height: 0.4, score: 0.88 },
    ]);
    const tracker = new LocalSubjectTracker(engine);
    const a = await tracker.track({ ...BASE_INPUT, mediaPath });
    const b = await tracker.track({ ...BASE_INPUT, mediaPath });
    expect(a).toEqual(b);
  });
});
