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
import { createSplitVideo, VERTICAL_WINDOW_WIDTH } from "../../../test/fixtures/createSplitVideo";
import { averageLuma } from "../../../test/fixtures/averageLuma";
import {
  createBandedVideo,
  LEFT_COLUMN,
  RIGHT_COLUMN,
} from "../../../test/fixtures/createBandedVideo";
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

describe("renderPreviewSegment — cadrage par plans (real ffmpeg)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-framing-"));
    sourcePath = path.join(workDir, "split.mp4");
    await createSplitVideo(sourcePath, 5);
  }, 60000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("montre le même changement de cadre que l'export, à l'instant près", async () => {
    // A preview that framed the clip differently from the export would be
    // worse than no preview at all: it would show an edit nobody is going
    // to receive.
    const outputPath = path.join(workDir, "preview-framed.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });
    const window = { y: 0, width: VERTICAL_WINDOW_WIDTH, height: 1 };

    const result = await renderPreviewSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      crop: { x: (1 - VERTICAL_WINDOW_WIDTH) / 2, ...window },
      renderPlan: {
        ...plan,
        framing: [
          {
            id: "shot-1",
            startSec: 0,
            endSec: 2,
            rect: { x: 0, ...window },
            transitionSec: 0,
            source: "speaker",
            label: "Intervenant A",
          },
          {
            id: "shot-2",
            startSec: 2,
            endSec: 4,
            rect: { x: 1 - VERTICAL_WINDOW_WIDTH, ...window },
            transitionSec: 0,
            source: "speaker",
            label: "Intervenant B",
          },
        ],
      },
    });

    expect(result.renderApplied.framing).toBe(2);
    expect(await averageLuma(outputPath, 0.5)).toBeGreaterThan(180);
    expect(await averageLuma(outputPath, 3)).toBeLessThan(80);

    const verified = await verifyExport(outputPath);
    expect(verified.width).toBe(PREVIEW_WIDTH);
    expect(verified.height).toBe(PREVIEW_HEIGHT);
    expect(verified.audioCodec).toBe("aac");
  }, 120000);
});

describe("renderPreviewSegment \u2014 effets 3D (real ffmpeg)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-3d-"));
    sourcePath = path.join(workDir, "banded.mp4");
    await createBandedVideo(sourcePath, 5);
  }, 60000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("incline l'image comme l'export l'inclinera, au m\u00eame instant", async () => {
    // Un aper\u00e7u qui montrerait un mouvement de cam\u00e9ra que l'export
    // n'appliquera pas \u2014 ou qui cacherait celui qu'il appliquera \u2014 serait
    // pire que pas d'aper\u00e7u du tout.
    const outputPath = path.join(workDir, "preview-tilted.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await renderPreviewSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      crop: { x: (1 - VERTICAL_WINDOW_WIDTH) / 2, y: 0, width: VERTICAL_WINDOW_WIDTH, height: 1 },
      renderPlan: {
        ...plan,
        perspectiveMoves: [
          { id: "m3d-1", startSec: 1, endSec: 3, direction: "left", profile: "swing", amount: 1 },
        ],
      },
    });

    expect(result.renderApplied.perspective).toBe(1);

    const flatLeft = await averageLuma(outputPath, 0.4, LEFT_COLUMN);
    const flatRight = await averageLuma(outputPath, 0.4, RIGHT_COLUMN);
    expect(Math.abs(flatLeft - flatRight)).toBeLessThan(6);

    const tiltedLeft = await averageLuma(outputPath, 2, LEFT_COLUMN);
    const tiltedRight = await averageLuma(outputPath, 2, RIGHT_COLUMN);
    expect(tiltedRight - tiltedLeft).toBeGreaterThan(6);

    const verified = await verifyExport(outputPath);
    expect(verified.width).toBe(PREVIEW_WIDTH);
    expect(verified.height).toBe(PREVIEW_HEIGHT);
    expect(verified.audioCodec).toBe("aac");
  }, 120000);
});
