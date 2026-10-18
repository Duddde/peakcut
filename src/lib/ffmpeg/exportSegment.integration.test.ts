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
import { createSplitVideo, VERTICAL_WINDOW_WIDTH } from "../../../test/fixtures/createSplitVideo";
import { averageLuma } from "../../../test/fixtures/averageLuma";
import {
  createBandedVideo,
  LEFT_COLUMN,
  RIGHT_COLUMN,
} from "../../../test/fixtures/createBandedVideo";
import type { TranscriptWord } from "@/lib/domain/types";
import type { FramingShot, Overlay } from "@/lib/effects/types";

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

const CENTERED_CROP = {
  x: (1 - VERTICAL_WINDOW_WIDTH) / 2,
  y: 0,
  width: VERTICAL_WINDOW_WIDTH,
  height: 1,
};

function framingShot(id: string, startSec: number, endSec: number, x: number, transitionSec = 0): FramingShot {
  return {
    id,
    startSec,
    endSec,
    rect: { x, y: 0, width: VERTICAL_WINDOW_WIDTH, height: 1 },
    transitionSec,
    source: "speaker",
    label: "Intervenant A",
  };
}

describe("exportSegment — cadrage par plans (real ffmpeg)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-framing-"));
    sourcePath = path.join(workDir, "split.mp4");
    await createSplitVideo(sourcePath, 5);
  }, 60000);

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("déplace réellement le cadre d'un côté à l'autre au moment dit", async () => {
    const outputPath = path.join(workDir, "framed.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: {
        ...plan,
        framing: [framingShot("shot-1", 0, 2, 0), framingShot("shot-2", 2, 4, 1 - VERTICAL_WINDOW_WIDTH)],
      },
    });

    expect(result.renderApplied.framing).toBe(2);

    // First shot: the frame is on the white half from edge to edge.
    expect(await averageLuma(outputPath, 0.5)).toBeGreaterThan(200);
    // Second shot: it is on the black half, and nothing of the white one
    // is left in frame.
    expect(await averageLuma(outputPath, 3)).toBeLessThan(60);

    const probe = await verifyExport(outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    // The crop moved inside a single filter: the audio stream has to come
    // out the other side untouched.
    expect(probe.audioCodec).toBe("aac");
  }, 120000);

  it("fait glisser le cadre quand le plan demande un panoramique", async () => {
    const outputPath = path.join(workDir, "panned.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: {
        ...plan,
        framing: [framingShot("shot-1", 0, 2, 0), framingShot("shot-2", 2, 4, 1 - VERTICAL_WINDOW_WIDTH, 1)],
      },
    });

    expect(result.renderApplied.framing).toBe(2);

    const before = await averageLuma(outputPath, 1);
    const during = await averageLuma(outputPath, 2.2);
    const after = await averageLuma(outputPath, 3.5);

    // Halfway through the pan the frame is halfway across: strictly
    // darker than the white half and strictly brighter than the black one.
    expect(during).toBeLessThan(before);
    expect(during).toBeGreaterThan(after);
  }, 120000);

  it("retombe sur le cadrage statique, et le dit, quand les plans se chevauchent", async () => {
    const outputPath = path.join(workDir, "overlapping.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: {
        ...plan,
        // A plan this broken is refused by validateRenderPlan before it
        // ever reaches ffmpeg; the export still has to produce the clip.
        framing: [framingShot("shot-1", 0, 3, 0), framingShot("shot-2", 1, 4, 1 - VERTICAL_WINDOW_WIDTH)],
      },
    });

    expect(result.renderApplied.framing).toBe(0);
    expect(result.renderLimitations.some((n) => /invalide|chevauchent/i.test(n))).toBe(true);
    await assertDecodable(outputPath);
  }, 120000);
});

describe("exportSegment \u2014 effets 3D (real ffmpeg)", () => {
  let workDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-3d-"));
    sourcePath = path.join(workDir, "banded.mp4");
    await createBandedVideo(sourcePath, 5);
  }, 60000);

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("incline r\u00e9ellement l'image au moment dit, et la laisse plate ailleurs", async () => {
    const outputPath = path.join(workDir, "tilted.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: {
        ...plan,
        perspectiveMoves: [
          {
            id: "m3d-1",
            startSec: 1,
            endSec: 3,
            direction: "left",
            profile: "swing",
            amount: 1,
          },
        ],
      },
    });

    expect(result.renderApplied.perspective).toBe(1);

    // Hors de la fen\u00eatre du mouvement, les deux colonnes voient la m\u00eame
    // bande blanche : l'image est plate, exactement comme avant les effets 3D.
    const flatLeft = await averageLuma(outputPath, 0.4, LEFT_COLUMN);
    const flatRight = await averageLuma(outputPath, 0.4, RIGHT_COLUMN);
    expect(Math.abs(flatLeft - flatRight)).toBeLessThan(4);

    // Au sommet du balancement, le bord gauche s'est avanc\u00e9 : il montre
    // moins de source agrandie, donc moins de blanc que le bord droit.
    const tiltedLeft = await averageLuma(outputPath, 2, LEFT_COLUMN);
    const tiltedRight = await averageLuma(outputPath, 2, RIGHT_COLUMN);
    expect(tiltedRight - tiltedLeft).toBeGreaterThan(8);

    // Et le clip revient \u00e0 plat apr\u00e8s le mouvement.
    const afterLeft = await averageLuma(outputPath, 3.6, LEFT_COLUMN);
    const afterRight = await averageLuma(outputPath, 3.6, RIGHT_COLUMN);
    expect(Math.abs(afterLeft - afterRight)).toBeLessThan(4);

    const probe = await verifyExport(outputPath);
    expect(probe.width).toBe(EXPORT_WIDTH);
    expect(probe.height).toBe(EXPORT_HEIGHT);
    // La chaîne 3D cale la cadence pour lire son horloge ; l'audio doit
    // sortir intact de l'autre c\u00f4t\u00e9.
    expect(probe.audioCodec).toBe("aac");
  }, 180000);

  it("incline l'autre axe quand le mouvement est vertical", async () => {
    const outputPath = path.join(workDir, "tilted-vertical.mp4");
    const plan = buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 4 });

    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 4,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: {
        ...plan,
        perspectiveMoves: [
          { id: "m3d-1", startSec: 1, endSec: 3, direction: "up", profile: "swing", amount: 1 },
        ],
      },
    });

    expect(result.renderApplied.perspective).toBe(1);
    // Une inclinaison verticale ne distingue pas la gauche de la droite :
    // elle pince les bords horizontaux, pas les verticaux.
    const left = await averageLuma(outputPath, 2, LEFT_COLUMN);
    const right = await averageLuma(outputPath, 2, RIGHT_COLUMN);
    expect(Math.abs(left - right)).toBeLessThan(6);
    // Mais elle change bien l'image : la bande blanche n'occupe plus la
    // m\u00eame part du cadre qu'\u00e0 plat.
    const flat = await averageLuma(outputPath, 0.4);
    const tilted = await averageLuma(outputPath, 2);
    expect(Math.abs(tilted - flat)).toBeGreaterThan(3);
  }, 180000);

  it("exporte \u00e0 plat, sans rien changer, quand le plan ne porte aucun mouvement", async () => {
    const outputPath = path.join(workDir, "flat.mp4");
    const result = await exportSegment({
      inputMediaPath: sourcePath,
      startSec: 0,
      endSec: 3,
      outputPath,
      words: [],
      crop: CENTERED_CROP,
      renderPlan: buildRenderPlan("clean-captions", { segmentId: "seg-1", segmentDurationSec: 3 }),
    });

    expect(result.renderApplied.perspective).toBe(0);
    const left = await averageLuma(outputPath, 1.5, LEFT_COLUMN);
    const right = await averageLuma(outputPath, 1.5, RIGHT_COLUMN);
    expect(Math.abs(left - right)).toBeLessThan(2);
  }, 180000);
});
