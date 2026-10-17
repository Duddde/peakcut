import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  renderPreviewSegment,
  PreviewDurationExceededError,
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
} from "./renderPreviewSegment";
import { verifyExport } from "./verifyExport";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";

describe("renderPreviewSegment (real ffmpeg + real ffprobe)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-render-"));
    sourcePath = path.join(workDir, "source.mp4");
    await createSyntheticVideo(sourcePath, 6);
  }, 60000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("produces a real low-resolution watermarked mp4, verified by ffprobe", async () => {
    const outputPath = path.join(workDir, "preview.mp4");
    const result = await renderPreviewSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 3,
      outputPath,
    });

    expect(result.durationSec).toBeCloseTo(2, 1);

    const verified = await verifyExport(outputPath);
    expect(verified.width).toBe(PREVIEW_WIDTH);
    expect(verified.height).toBe(PREVIEW_HEIGHT);
    expect(verified.videoCodec).toBe("h264");
    expect(verified.audioCodec).toBe("aac");
    expect(verified.durationSec).toBeGreaterThan(1.5);
  }, 30000);

  it("composites an illustration into the preview, so the preview shows the edit being edited", async () => {
    const imagePath = path.join(workDir, "white.png");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        ["-y", "-f", "lavfi", "-i", "color=white:s=216x384", "-frames:v", "1", imagePath],
        { stdio: "ignore" }
      );
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg code ${code}`))));
    });

    const assetId = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";
    const renderPlan = buildRenderPlan("clean-captions", { segmentId: "seg", segmentDurationSec: 2 });
    renderPlan.overlays = [
      {
        id: "ov-1",
        assetId,
        startSec: 0.5,
        endSec: 1.5,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 1,
        fadeSec: 0,
      },
    ];

    const outputPath = path.join(workDir, "preview-overlay.mp4");
    const result = await renderPreviewSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 3,
      outputPath,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      renderPlan,
      overlayFiles: { [assetId]: imagePath },
    });

    expect(result.renderApplied.overlays).toBe(1);

    const verified = await verifyExport(outputPath);
    expect(verified.width).toBe(PREVIEW_WIDTH);
    expect(verified.height).toBe(PREVIEW_HEIGHT);
    expect(verified.videoCodec).toBe("h264");
    expect(verified.audioCodec).toBe("aac");
  }, 60000);

  it("rejects a segment longer than the free preview cap without touching ffmpeg", async () => {
    const outputPath = path.join(workDir, "too-long.mp4");
    await expect(
      renderPreviewSegment({ inputMediaPath: sourcePath, startSec: 0, endSec: 25, outputPath })
    ).rejects.toThrow(PreviewDurationExceededError);
  });
});
