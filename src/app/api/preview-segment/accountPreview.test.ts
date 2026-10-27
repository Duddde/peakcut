// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createPreviewSegmentHandler } from "./route";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import { createSyntheticVideo } from "../../../../test/fixtures/createSyntheticVideo";
import { createFixedWindowRateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";

/** Longer than both the trial window (15 s) and the free tier's renderer cap (20 s). */
const SOURCE_DURATION_SEC = 25;

function seedProject(deps: AppDeps, sourcePath: string) {
  const user = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  const cookie = signSessionId(session.id, deps.authSecret);
  const projectId = "p-account-preview";
  const now = new Date().toISOString();
  new SqliteProjectRepository(deps.db).createProject(user.id, {
    id: projectId,
    title: "P",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: "src",
      type: "local-upload",
      title: "S",
      localFilePath: sourcePath,
      durationSec: SOURCE_DURATION_SEC,
      originTimestamp: now,
      confidence: 1,
    },
    transcript: null,
    segments: [
      {
        id: "s",
        projectId,
        title: "S",
        startSec: 0,
        endSec: 22,
        words: [],
        score: null,
        safeZones: [],
        variants: [],
        renderPlan: null,
      },
    ],
    timeline: null,
    workflow: createInitialWorkflow(),
  });
  return { cookie, projectId };
}

function post(body: unknown, cookie: string): NextRequest {
  return new NextRequest("http://localhost/api/preview-segment", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/preview-segment — an account's project (real ffmpeg)", () => {
  let workDir: string;
  let uploadsDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-account-preview-"));
    uploadsDir = path.join(workDir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    sourcePath = path.join(uploadsDir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
  }, 60000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function handler(deps: AppDeps) {
    return createPreviewSegmentHandler({
      uploadsBaseDir: uploadsDir,
      previewsBaseDir: path.join(workDir, "previews"),
      appDeps: deps,
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    });
  }

  it("previews the whole clip, not the trial's first 15 seconds", async () => {
    const deps = createTestAppDeps();
    const { cookie, projectId } = seedProject(deps, sourcePath);

    const res = await handler(deps)(post({ projectId, segmentId: "s" }, cookie));

    expect(res.status).toBe(201);
    expect((await res.json()).durationSec).toBeCloseTo(22, 3);
  }, 120000);

  it("renders the studio's unsaved version of the clip when it is sent along", async () => {
    const deps = createTestAppDeps();
    const { cookie, projectId } = seedProject(deps, sourcePath);
    const edited = {
      id: "s",
      title: "S",
      startSec: 2,
      endSec: 5,
      words: [],
      score: null,
      safeZones: [],
      variants: [{ id: "v", label: "9:16", aspectRatio: "9:16", crop: { x: 0.2, y: 0, width: 0.32, height: 1 } }],
      renderPlan: null,
    };

    const res = await handler(deps)(post({ projectId, segmentId: "s", variantId: "v", segment: edited }, cookie));

    expect(res.status).toBe(201);
    expect((await res.json()).durationSec).toBeCloseTo(3, 3);
  }, 120000);

  it("rejects a malformed unsaved clip instead of rendering something else", async () => {
    const deps = createTestAppDeps();
    const { cookie, projectId } = seedProject(deps, sourcePath);

    const res = await handler(deps)(post({ projectId, segmentId: "s", segment: { id: "s" } }, cookie));

    expect(res.status).toBe(400);
  });
});
