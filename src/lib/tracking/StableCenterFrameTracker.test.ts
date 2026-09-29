import { describe, expect, it } from "vitest";
import { StableCenterFrameTracker } from "./StableCenterFrameTracker";

describe("StableCenterFrameTracker", () => {
  it("has a stable id and display name", () => {
    const tracker = new StableCenterFrameTracker();
    expect(tracker.id).toBe("stable-center-fallback");
    expect(tracker.displayName).toBeTruthy();
  });

  it("always reports fallbackUsed: true (no real face detection)", async () => {
    const tracker = new StableCenterFrameTracker();
    const track = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 });
    expect(track.fallbackUsed).toBe(true);
    expect(track.method).toBe("centered-fallback-no-face-model");
  });

  it("produces keyframes centered at cx=0.5, cy=0.5", async () => {
    const tracker = new StableCenterFrameTracker();
    const track = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 });
    expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
    for (const kf of track.keyframes) {
      expect(kf.cx).toBe(0.5);
      expect(kf.cy).toBe(0.5);
    }
  });

  it("reports a low, honest confidence rather than pretending certainty", async () => {
    const tracker = new StableCenterFrameTracker();
    const track = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 });
    for (const kf of track.keyframes) {
      expect(kf.confidence).toBeGreaterThan(0);
      expect(kf.confidence).toBeLessThanOrEqual(0.4);
    }
  });

  it("spans keyframes from 0 to the full duration", async () => {
    const tracker = new StableCenterFrameTracker();
    const track = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 8 });
    expect(track.keyframes[0].tSec).toBe(0);
    expect(track.keyframes[track.keyframes.length - 1].tSec).toBe(8);
  });

  it("is deterministic across calls with the same input", async () => {
    const tracker = new StableCenterFrameTracker();
    const a = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 });
    const b = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 10 });
    expect(a).toEqual(b);
  });

  it("performs no network I/O and requires no model file", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      const tracker = new StableCenterFrameTracker();
      await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 3 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  it("handles a zero-duration input without crashing", async () => {
    const tracker = new StableCenterFrameTracker();
    const track = await tracker.track({ sourceWidth: 1920, sourceHeight: 1080, durationSec: 0 });
    expect(track.keyframes.length).toBeGreaterThanOrEqual(1);
  });
});
