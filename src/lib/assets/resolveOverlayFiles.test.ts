import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import type { Overlay, RenderPlan } from "@/lib/effects/types";
import type { AssetRecord, AssetRepository } from "./AssetRepository";
import { resolveOverlayFiles } from "./resolveOverlayFiles";

const BASE = path.join(path.resolve(path.sep), "srv", "assets");
const ID_A = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";
const ID_B = "2a4c9d3b-6e5f-4a7b-8c2d-3f4e5a6b7c8d";

function record(id: string, projectId: string): AssetRecord {
  return {
    id,
    projectId,
    mimeType: "image/png",
    sizeBytes: 1024,
    origin: "upload",
    prompt: null,
    providerId: null,
    createdAt: new Date().toISOString(),
  };
}

function repoWith(records: AssetRecord[]): AssetRepository {
  return {
    createAsset: () => undefined,
    deleteAsset: () => false,
    listAssets: (projectId) => records.filter((r) => r.projectId === projectId),
    getAsset: (projectId, assetId) =>
      records.find((r) => r.projectId === projectId && r.id === assetId) ?? null,
  };
}

function overlay(assetId: string, id = "ov"): Overlay {
  return {
    id,
    assetId,
    startSec: 1,
    endSec: 3,
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
    opacity: 1,
    fadeSec: 0.2,
  };
}

function planWith(overlays: Overlay[]): RenderPlan {
  return { ...buildRenderPlan("subtle-punch", { segmentId: "s", segmentDurationSec: 10 }), overlays };
}

describe("resolveOverlayFiles", () => {
  it("resolves each illustration of the project to its file", () => {
    const files = resolveOverlayFiles(planWith([overlay(ID_A)]), "p1", {
      repo: repoWith([record(ID_A, "p1")]),
      baseDir: BASE,
      fileExists: () => true,
    });
    expect(files).toEqual({ [ID_A]: path.join(BASE, "p1", `${ID_A}.png`) });
  });

  it("resolves nothing for a plan without illustrations", () => {
    expect(
      resolveOverlayFiles(planWith([]), "p1", { repo: repoWith([]), baseDir: BASE, fileExists: () => true })
    ).toEqual({});
    expect(
      resolveOverlayFiles(null, "p1", { repo: repoWith([]), baseDir: BASE, fileExists: () => true })
    ).toEqual({});
  });

  it("will not resolve an asset belonging to another project", () => {
    const files = resolveOverlayFiles(planWith([overlay(ID_A)]), "p1", {
      repo: repoWith([record(ID_A, "autre-projet")]),
      baseDir: BASE,
      fileExists: () => true,
    });
    expect(files).toEqual({});
  });

  it("skips a record whose bytes have gone missing, instead of handing ffmpeg a dead path", () => {
    const files = resolveOverlayFiles(planWith([overlay(ID_A)]), "p1", {
      repo: repoWith([record(ID_A, "p1")]),
      baseDir: BASE,
      fileExists: () => false,
    });
    expect(files).toEqual({});
  });

  it("resolves what it can and leaves out what it cannot", () => {
    const files = resolveOverlayFiles(planWith([overlay(ID_A, "a"), overlay(ID_B, "b")]), "p1", {
      repo: repoWith([record(ID_A, "p1")]),
      baseDir: BASE,
      fileExists: () => true,
    });
    expect(Object.keys(files)).toEqual([ID_A]);
  });

  it("looks an asset up once even when several illustrations share it", () => {
    const lookups: string[] = [];
    const repo = repoWith([record(ID_A, "p1")]);
    const counting: AssetRepository = {
      ...repo,
      getAsset: (projectId, assetId) => {
        lookups.push(assetId);
        return repo.getAsset(projectId, assetId);
      },
    };
    resolveOverlayFiles(planWith([overlay(ID_A, "a"), overlay(ID_A, "b")]), "p1", {
      repo: counting,
      baseDir: BASE,
      fileExists: () => true,
    });
    expect(lookups).toEqual([ID_A]);
  });
});
