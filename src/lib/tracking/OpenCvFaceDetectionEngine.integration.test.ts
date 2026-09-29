import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenCvFaceDetectionEngine, OpenCvEngineExecutionError } from "./OpenCvFaceDetectionEngine";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "vision", "track_faces.py");

describe("OpenCvFaceDetectionEngine (real python3 subprocess)", () => {
  let dir: string;
  let mediaPath: string;
  let cv2Available: boolean;
  let engine: OpenCvFaceDetectionEngine;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-opencv-"));
    mediaPath = path.join(dir, "clip.mp4");
    await createSyntheticVideo(mediaPath, 2);

    engine = new OpenCvFaceDetectionEngine({ scriptPath: SCRIPT_PATH });
    cv2Available = await engine.isAvailable();
  }, 30000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("isAvailable() resolves to a real boolean without throwing", () => {
    expect(typeof cv2Available).toBe("boolean");
  });

  it("reports a clean, controlled error when OpenCV is not installed", async (context) => {
    if (cv2Available) {
      // This environment has OpenCV installed; the "not installed" path doesn't apply.
      context.skip();
      return;
    }
    try {
      await engine.detect({ mediaPath, sourceWidth: 1280, sourceHeight: 720, durationSec: 2 });
      throw new Error("expected engine.detect to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenCvEngineExecutionError);
      expect((err as Error).message.toLowerCase()).toContain("opencv");
    }
  }, 15000);

  it("runs real face detection end-to-end when OpenCV is available (skipped otherwise)", async (context) => {
    if (!cv2Available) {
      context.skip();
      return;
    }
    const result = await engine.detect({ mediaPath, sourceWidth: 1280, sourceHeight: 720, durationSec: 2 });
    expect(Array.isArray(result)).toBe(true);
    for (const box of result) {
      expect(box.score).toBeGreaterThanOrEqual(0);
      expect(box.score).toBeLessThanOrEqual(1);
    }
  }, 30000);
});
