import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportSegment, EXPORT_WIDTH, EXPORT_HEIGHT } from "./exportSegment";
import { verifyExport } from "./verifyExport";
import { assertDecodable } from "./assertDecodable";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";
import type { TranscriptWord } from "@/lib/domain/types";

const SOURCE_DURATION_SEC = 6;

function demoWords(): TranscriptWord[] {
  const script = ["Ceci", "est", "un", "test", "réel", "d'export", "vertical"];
  let t = 0.5;
  return script.map((text) => {
    const w: TranscriptWord = { text, startSec: t, endSec: t + 0.4, speaker: "A", confidence: 0.9 };
    t += 0.5;
    return w;
  });
}

describe("exportSegment (real ffmpeg + real ffprobe)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-export-"));
    sourcePath = path.join(workDir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
  }, 60000);

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("produces a real 1080x1920 H.264/AAC file verified by ffprobe", async () => {
    const outputPath = path.join(workDir, "clip.mp4");
    const words = demoWords();

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath,
      words,
    });

    expect(result.durationSec).toBeCloseTo(3, 5);

    const fileInfo = await stat(outputPath);
    expect(fileInfo.size).toBeGreaterThan(0);

    const assInfo = await stat(result.assPath);
    expect(assInfo.size).toBeGreaterThan(0);

    const probe = await verifyExport(outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");
    expect(probe.durationSec).toBeGreaterThan(2.5);
    expect(probe.durationSec).toBeLessThan(3.5);
  }, 60000);

  it("applies a custom crop rectangle when provided", async () => {
    const outputPath = path.join(workDir, "clip-cropped.mp4");
    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 2,
      outputPath,
      words: [],
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    });

    const probe = await verifyExport(result.outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    expect(probe.videoCodec).toBe("h264");
  }, 60000);

  it("applies a hook-emphasis render plan (animated zoom + subtitle style) without error, verified by ffprobe and real decode", async () => {
    const outputPath = path.join(workDir, "clip-hook-emphasis.mp4");
    const words = demoWords();
    const renderPlan = buildRenderPlan("hook-emphasis", { segmentId: "seg-hook", segmentDurationSec: 3 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath,
      words,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      renderPlan,
    });

    expect(result.renderApplied.zoom).toBe(true);
    expect(result.renderApplied.subtitleStyle).toBe(true);
    expect(result.renderApplied.templateId).toBe("hook-emphasis");

    const probe = await verifyExport(result.outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");

    await expect(assertDecodable(result.outputPath)).resolves.toBeUndefined();
  }, 60000);

  it("applies subtitle style but skips zoom when a render plan is given without a base crop", async () => {
    const outputPath = path.join(workDir, "clip-plan-no-crop.mp4");
    const renderPlan = buildRenderPlan("hook-emphasis", { segmentId: "seg-2", segmentDurationSec: 3 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath,
      words: demoWords(),
      renderPlan,
    });

    expect(result.renderApplied.zoom).toBe(false);
    expect(result.renderApplied.subtitleStyle).toBe(true);
    expect(result.renderLimitations.some((n) => /cadrage/i.test(n))).toBe(true);

    const probe = await verifyExport(result.outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
  }, 60000);

  it("falls back safely to a static crop and unstyled subtitles when the render plan is out of bounds", async () => {
    const outputPath = path.join(workDir, "clip-plan-invalid.mp4");
    const renderPlan = buildRenderPlan("hook-emphasis", { segmentId: "seg-3", segmentDurationSec: 3 });
    renderPlan.zoomKeyframes = [{ tSec: 0, scale: 50 }];

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath,
      words: demoWords(),
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      renderPlan,
    });

    expect(result.renderApplied.zoom).toBe(false);
    expect(result.renderApplied.subtitleStyle).toBe(false);
    expect(result.renderLimitations.some((n) => /invalide/i.test(n))).toBe(true);

    const probe = await verifyExport(result.outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    expect(probe.videoCodec).toBe("h264");
  }, 60000);

  it("rejects an invalid time range before touching ffmpeg", async () => {
    await expect(
      exportSegment({
        inputMediaPath: sourcePath,
        startSec: 3,
        endSec: 3,
        outputPath: path.join(workDir, "invalid.mp4"),
        words: [],
      })
    ).rejects.toThrow(/endSec/);
  });
});
