import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoSubjectDetectionEngine, SubjectDetectionUnavailableError } from "./AutoSubjectDetectionEngine";
import type { DetectedBoundingBox, SubjectDetectionInput } from "./types";

const BASE_INPUT: SubjectDetectionInput = {
  mediaPath: "/tmp/does-not-matter.mp4",
  sourceWidth: 1920,
  sourceHeight: 1080,
  durationSec: 4,
};

const CANNED_BOX: DetectedBoundingBox = { tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.3, score: 0.8 };

describe("AutoSubjectDetectionEngine", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("delegates to the command engine when PEAKCUT_TRACKER_COMMAND is configured, without probing OpenCV", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "/usr/bin/true");
    let openCvProbed = false;
    const engine = new AutoSubjectDetectionEngine({
      commandEngineFactory: () => ({ id: "command-subject-detector", detect: async () => [CANNED_BOX] }),
      openCvEngineFactory: () => ({
        id: "opencv-face-detector",
        isAvailable: async () => {
          openCvProbed = true;
          return true;
        },
        detect: async () => [],
      }),
    });
    const result = await engine.detect(BASE_INPUT);
    expect(result).toEqual([CANNED_BOX]);
    expect(openCvProbed).toBe(false);
  });

  it("delegates to OpenCV when no command is configured and OpenCV is available", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "");
    const engine = new AutoSubjectDetectionEngine({
      openCvEngineFactory: () => ({
        id: "opencv-face-detector",
        isAvailable: async () => true,
        detect: async () => [CANNED_BOX],
      }),
    });
    const result = await engine.detect(BASE_INPUT);
    expect(result).toEqual([CANNED_BOX]);
  });

  it("throws SubjectDetectionUnavailableError when no command is configured and OpenCV is unavailable", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "");
    const engine = new AutoSubjectDetectionEngine({
      openCvEngineFactory: () => ({
        id: "opencv-face-detector",
        isAvailable: async () => false,
        detect: async () => [CANNED_BOX],
      }),
    });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(SubjectDetectionUnavailableError);
  });

  it("never fabricates a fake detection when unavailable", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "");
    const engine = new AutoSubjectDetectionEngine({
      openCvEngineFactory: () => ({
        id: "opencv-face-detector",
        isAvailable: async () => false,
        detect: async () => [CANNED_BOX],
      }),
    });
    await expect(engine.detect(BASE_INPUT)).rejects.toThrow(/indisponible|unavailable/i);
  });

  it("propagates a real command-engine error instead of silently falling back to OpenCV", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "/usr/bin/true");
    const engine = new AutoSubjectDetectionEngine({
      commandEngineFactory: () => ({
        id: "command-subject-detector",
        detect: async () => {
          throw new Error("configured command crashed");
        },
      }),
      openCvEngineFactory: () => ({
        id: "opencv-face-detector",
        isAvailable: async () => true,
        detect: async () => [CANNED_BOX],
      }),
    });
    await expect(engine.detect(BASE_INPUT)).rejects.toThrow("configured command crashed");
  });
});
