// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { Project } from "@/lib/domain/types";
import { SqliteAssetRepository } from "./AssetRepository";
import { AssetStoreError, assetPathOf, deleteAsset, readAsset, saveAsset } from "./assetStore";

function png(): Buffer {
  const data = Buffer.alloc(256);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  return data;
}

function project(id: string): Project {
  return {
    id,
    title: "Projet",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "draft",
    source: {
      id: "src-1",
      type: "local-upload",
      title: "video.mp4",
      durationSec: 120,
      originTimestamp: new Date().toISOString(),
      confidence: 1,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
}

async function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const projects = new SqliteProjectRepository(db);
  const owner = users.createUser("owner@example.com", "hash");
  projects.createProject(owner.id, project("proj-1"));
  projects.createProject(owner.id, project("proj-2"));
  const baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-assets-"));
  return { db, projects, owner, options: { baseDir, repo: new SqliteAssetRepository(db) } };
}

describe("saveAsset", () => {
  it("writes the bytes and records the asset", async () => {
    const { options } = await setup();
    const record = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);

    expect(record.mimeType).toBe("image/png");
    expect(record.sizeBytes).toBe(256);
    expect(record.origin).toBe("upload");

    const filePath = assetPathOf(record, options.baseDir)!;
    expect((await stat(filePath)).size).toBe(256);
    expect(await readFile(filePath)).toEqual(png());
  });

  it("keeps the prompt and the provider of a generated illustration", async () => {
    const { options } = await setup();
    const record = await saveAsset(
      {
        projectId: "proj-1",
        data: png(),
        origin: "generated",
        prompt: "un graphique qui monte",
        providerId: "openai-gpt-image-1",
      },
      options
    );
    expect(options.repo.getAsset("proj-1", record.id)).toMatchObject({
      origin: "generated",
      prompt: "un graphique qui monte",
      providerId: "openai-gpt-image-1",
    });
  });

  it("refuses bytes that are not an image, before anything is written", async () => {
    const { options } = await setup();
    await expect(
      saveAsset({ projectId: "proj-1", data: Buffer.from("pas une image"), origin: "upload" }, options)
    ).rejects.toBeInstanceOf(AssetStoreError);
    expect(options.repo.listAssets("proj-1")).toEqual([]);
  });

  it("gives each project its own folder", async () => {
    const { options } = await setup();
    const a = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    const b = await saveAsset({ projectId: "proj-2", data: png(), origin: "upload" }, options);
    expect(path.dirname(assetPathOf(a, options.baseDir)!)).not.toBe(
      path.dirname(assetPathOf(b, options.baseDir)!)
    );
  });
});

describe("readAsset", () => {
  it("reads back an asset of the project it belongs to", async () => {
    const { options } = await setup();
    const record = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    const loaded = await readAsset("proj-1", record.id, options);
    expect(loaded?.data).toEqual(png());
  });

  it("will not read one project asset through another project", async () => {
    const { options } = await setup();
    const record = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    expect(await readAsset("proj-2", record.id, options)).toBeNull();
  });

  it("returns null for an unknown id rather than throwing", async () => {
    const { options } = await setup();
    expect(await readAsset("proj-1", "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c", options)).toBeNull();
  });
});

describe("deleteAsset", () => {
  it("removes the row and the bytes", async () => {
    const { options } = await setup();
    const record = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    const filePath = assetPathOf(record, options.baseDir)!;

    expect(await deleteAsset("proj-1", record.id, options)).toBe(true);
    expect(options.repo.getAsset("proj-1", record.id)).toBeNull();
    await expect(stat(filePath)).rejects.toThrow();
  });

  it("refuses to delete through another project", async () => {
    const { options } = await setup();
    const record = await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    expect(await deleteAsset("proj-2", record.id, options)).toBe(false);
    expect(options.repo.getAsset("proj-1", record.id)).not.toBeNull();
  });
});

describe("assets and their project", () => {
  it("disappear with the project, since the row cascades", async () => {
    const { options, projects } = await setup();
    await saveAsset({ projectId: "proj-1", data: png(), origin: "upload" }, options);
    projects.deleteProject("proj-1");
    expect(options.repo.listAssets("proj-1")).toEqual([]);
  });
});
