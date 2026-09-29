import type { FrameTrack, FrameTracker, FrameTrackerInput } from "./types";

/**
 * Deterministic, offline fallback tracker. It does NOT detect a face or any
 * real subject — it simply keeps the crop centered on the source frame for
 * the whole duration. `fallbackUsed` is always true and confidence is kept
 * low (<= 0.4) so nothing downstream can mistake this for a real detection
 * result. This exists so the rest of the crop-following pipeline (safe
 * zones, variants, export) has a concrete, testable FrameTrack to consume
 * before any real detection model is ever wired in.
 */
const CENTER = 0.5;
const FALLBACK_CONFIDENCE = 0.3;

export class StableCenterFrameTracker implements FrameTracker {
  readonly id = "stable-center-fallback";
  readonly displayName = "Cadrage centré stable (repli déterministe, sans détection de visage)";

  async track(input: FrameTrackerInput): Promise<FrameTrack> {
    const durationSec = Math.max(0, input.durationSec);
    const times = durationSec === 0 ? [0] : [0, durationSec];

    return {
      keyframes: times.map((tSec) => ({
        tSec,
        cx: CENTER,
        cy: CENTER,
        confidence: FALLBACK_CONFIDENCE,
      })),
      fallbackUsed: true,
      method: "centered-fallback-no-face-model",
    };
  }
}
