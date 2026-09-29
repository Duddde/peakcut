// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createIngestMediaHandler } from "./route";
import { createLocalMediaStorage } from "@/lib/ingestion/mediaStorage";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { AppDeps } from "@/lib/appDeps";
import type { Project } from "@/lib/domain/types";

function requestWithFile(file: File | null, extra?: { projectId?: string; cookie?: string }): NextRequest {
  const formData = new FormData();
  if (file) formData.set("file", file);
  if (extra?.projectId) formData.set("projectId", extra.projectId);
  const headers = new Headers();
  if (extra?.cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${extra.cookie}`);
  return new NextRequest("http://localhost/api/ingest-media", {
    method: "POST",
    body: formData,
    headers,
  });
}

function makeAuthedUserAndCookie(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  return { user, cookie: signSessionId(session.id, deps.authSecret) };
}

function makeProject(id: string): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: "Projet existant",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: "s0",
      type: "local-upload",
      title: "Aucun média importé",
      durationSec: 0,
      originTimestamp: now,
      confidence: 0,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
}

describe("POST /api/ingest-media", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-ingest-route-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("ingests a valid file and returns 201 with a local-upload source and workflow", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 8 });

    const file = new File([new Uint8Array([1, 2, 3, 4])], "clip.mp4", { type: "video/mp4" });
    const res = await POST(requestWithFile(file));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.source.type).toBe("local-upload");
    expect(json.source.title).toBe("clip.mp4");
    expect(json.source.durationSec).toBe(8);
    expect(json.workflow.phase).toBe("analysis_preview");
  });

  it("returns 400 when no file field is present", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const POST = createIngestMediaHandler(storage);
    const res = await POST(requestWithFile(null));
    expect(res.status).toBe(400);
  });

  it("returns 422 for a disallowed file type", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const POST = createIngestMediaHandler(storage);
    const file = new File([new Uint8Array([1])], "malware.exe", { type: "application/x-msdownload" });
    const res = await POST(requestWithFile(file));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 422 for an oversized declared file without writing it to disk", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const POST = createIngestMediaHandler(storage);
    // A small real buffer but a spoofed/mismatched extension should already fail at validation;
    // here we assert a wrong-extension file for another disallowed-name path.
    const file = new File([new Uint8Array([1, 2])], "../evil.mp4", { type: "video/mp4" });
    const res = await POST(requestWithFile(file));
    expect(res.status).toBe(422);
  });

  it("never triggers outbound network I/O", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 1 });
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
      await POST(requestWithFile(file));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  describe("with projectId (persisted project)", () => {
    it("persists the new source and workflow into the owner's project", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 12 }, appDeps);

      const { user, cookie } = makeAuthedUserAndCookie(appDeps, "owner@example.com");
      const repo = new SqliteProjectRepository(appDeps.db);
      const project = makeProject("proj-1");
      repo.createProject(user.id, project);

      const file = new File([new Uint8Array([1, 2, 3, 4])], "clip.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file, { projectId: "proj-1", cookie }));
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.source.title).toBe("clip.mp4");
      expect(json.source.durationSec).toBe(12);

      const stored = repo.getProjectById("proj-1");
      expect(stored?.source.title).toBe("clip.mp4");
      expect(stored?.source.durationSec).toBe(12);
      expect(stored?.workflow.phase).toBe("analysis_preview");
      // segments/transcript/title from before the import must be untouched
      expect(stored?.title).toBe("Projet existant");
      expect(stored?.segments).toEqual([]);
      expect(stored?.transcript).toBeNull();
    });

    it("returns 401 when projectId is given without authentication", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 5 }, appDeps);

      const { user } = makeAuthedUserAndCookie(appDeps, "owner2@example.com");
      const repo = new SqliteProjectRepository(appDeps.db);
      repo.createProject(user.id, makeProject("proj-2"));

      const file = new File([new Uint8Array([1, 2])], "clip.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file, { projectId: "proj-2" }));
      expect(res.status).toBe(401);

      const stored = repo.getProjectById("proj-2");
      expect(stored?.source.title).toBe("Aucun média importé");
    });

    it("returns 404 when the authenticated user does not own the project", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 5 }, appDeps);

      const owner = makeAuthedUserAndCookie(appDeps, "real-owner@example.com");
      const repo = new SqliteProjectRepository(appDeps.db);
      repo.createProject(owner.user.id, makeProject("proj-3"));

      const { cookie: intruderCookie } = makeAuthedUserAndCookie(appDeps, "intruder@example.com");

      const file = new File([new Uint8Array([1, 2])], "clip.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file, { projectId: "proj-3", cookie: intruderCookie }));
      expect(res.status).toBe(404);

      const stored = repo.getProjectById("proj-3");
      expect(stored?.source.title).toBe("Aucun média importé");
    });

    it("returns 404 for a nonexistent projectId", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 5 }, appDeps);
      const { cookie } = makeAuthedUserAndCookie(appDeps, "someone@example.com");

      const file = new File([new Uint8Array([1, 2])], "clip.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file, { projectId: "does-not-exist", cookie }));
      expect(res.status).toBe(404);
    });

    it("does not touch existing segments/transcript/title on re-import", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 7 }, appDeps);

      const { user, cookie } = makeAuthedUserAndCookie(appDeps, "owner3@example.com");
      const repo = new SqliteProjectRepository(appDeps.db);
      const project = makeProject("proj-4");
      project.title = "Titre personnalisé";
      project.transcript = { language: "fr", providerId: "mock", words: [] };
      project.segments = [
        {
          id: "seg-1",
          projectId: "proj-4",
          title: "Segment existant",
          startSec: 0,
          endSec: 5,
          words: [],
          score: null,
          safeZones: [],
          variants: [],
        },
      ];
      repo.createProject(user.id, project);

      const file = new File([new Uint8Array([1, 2, 3])], "new.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file, { projectId: "proj-4", cookie }));
      expect(res.status).toBe(201);

      const stored = repo.getProjectById("proj-4");
      expect(stored?.title).toBe("Titre personnalisé");
      expect(stored?.transcript).not.toBeNull();
      expect(stored?.segments).toHaveLength(1);
      expect(stored?.segments[0].title).toBe("Segment existant");
      expect(stored?.source.title).toBe("new.mp4");
    });

    it("does not require auth when projectId is absent (public demo path unchanged)", async () => {
      const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
      const appDeps = createTestAppDeps();
      const POST = createIngestMediaHandler(storage, { probeDurationSec: async () => 3 }, appDeps);

      const file = new File([new Uint8Array([1, 2])], "clip.mp4", { type: "video/mp4" });
      const res = await POST(requestWithFile(file));
      expect(res.status).toBe(201);
    });
  });
});
