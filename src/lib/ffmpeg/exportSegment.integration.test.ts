import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportSegment, EXPORT_WIDTH, EXPORT_HEIGHT } from "./exportSegment";
import { verifyExport } from "./verifyExport";
import { assertDecodable } from "./assertDecodable";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";
import type { TranscriptWord } from "@/lib/domain/types";
import type { Overlay } from "@/lib/effects/types";

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


/** A real image file, made by ffmpeg itself rather than committed to the repo. */
function createSolidImage(outputPath: string, color: string, size = "200x200"): Promise<void> {
  return runFfmpegForTest(["-y", "-f", "lavfi", "-i", `color=${color}:s=${size}`, "-frames:v", "1", outputPath]);
}

function runFfmpegForTest(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg (test) code ${code}:
${stderr.slice(-2000)}`))
    );
  });
}

/**
 * Average brightness of one frame of a finished clip, decoded to raw
 * 8-bit grey and averaged in JS. Crude on purpose: it needs no image
 * library, and it is enough to tell "a white picture is on screen here"
 * from "it is not" — which is the only thing an overlay test has to prove.
 */
function averageLuma(clipPath: string, atSec: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", atSec.toFixed(3),
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", "scale=64:64",
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const data = Buffer.concat(chunks);
      if (data.length === 0) {
        reject(new Error(`Aucune image décodée à t=${atSec}s dans ${clipPath}.`));
        return;
      }
      let total = 0;
      for (const byte of data) total += byte;
      resolve(total / data.length);
    });
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

  it("really composites an illustration, and only inside its own window", async () => {
    const imagePath = path.join(workDir, "white.png");
    // 9:16 like the output, so fitting it into a full-frame box fills the
    // frame: the image keeps its aspect ratio, so a square one would leave
    // bands of video showing and the measurement below would be ambiguous.
    await createSolidImage(imagePath, "white", "216x384");

    const assetId = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";
    const overlay: Overlay = {
      id: "ov-1",
      assetId,
      startSec: 1.5,
      endSec: 2.5,
      // The whole frame, so the measurement cannot miss it.
      rect: { x: 0, y: 0, width: 1, height: 1 },
      opacity: 1,
      fadeSec: 0,
    };
    const renderPlan = buildRenderPlan("clean-captions", { segmentId: "seg-ov", segmentDurationSec: 3 });
    renderPlan.overlays = [overlay];

    const outputPath = path.join(workDir, "clip-overlay.mp4");
    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath,
      words: [],
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      renderPlan,
      overlayFiles: { [assetId]: imagePath },
    });

    expect(result.renderApplied.overlays).toBe(1);

    const probe = await verifyExport(result.outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    expect(probe.videoCodec).toBe("h264");
    // The audio survives the move from -vf to -filter_complex, which is
    // exactly what an explicit -map could have silently dropped.
    expect(probe.audioCodec).toBe("aac");
    await expect(assertDecodable(result.outputPath)).resolves.toBeUndefined();

    const during = await averageLuma(result.outputPath, 2);
    const before = await averageLuma(result.outputPath, 0.5);
    expect(during).toBeGreaterThan(240);
    expect(before).toBeLessThan(200);
  }, 120000);

  it("exports the clip without the illustration when its image is missing, rather than failing", async () => {
    const renderPlan = buildRenderPlan("clean-captions", { segmentId: "seg-ov2", segmentDurationSec: 3 });
    renderPlan.overlays = [
      {
        id: "ov-manquante",
        assetId: "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c",
        startSec: 1,
        endSec: 2,
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
        opacity: 1,
        fadeSec: 0,
      },
    ];

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 1,
      endSec: 4,
      outputPath: path.join(workDir, "clip-overlay-missing.mp4"),
      words: [],
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      renderPlan,
      overlayFiles: {},
    });

    expect(result.renderApplied.overlays).toBe(0);
    expect(result.renderLimitations.some((n) => /introuvable/i.test(n))).toBe(true);
    expect((await verifyExport(result.outputPath)).videoCodec).toBe("h264");
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
