import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("rejects a segment longer than the free preview cap without touching ffmpeg", async () => {
    const outputPath = path.join(workDir, "too-long.mp4");
    await expect(
      renderPreviewSegment({ inputMediaPath: sourcePath, startSec: 0, endSec: 25, outputPath })
    ).rejects.toThrow(PreviewDurationExceededError);
  });
});
