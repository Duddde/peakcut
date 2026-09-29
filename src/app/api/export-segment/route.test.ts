// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createExportSegmentHandler } from "./route";
import { createInitialWorkflow, authorizeExport, confirmRights } from "@/lib/workflow/workflow";
import { createSyntheticVideo } from "../../../../test/fixtures/createSyntheticVideo";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import type { AppDeps } from "@/lib/appDeps";

const SOURCE_DURATION_SEC = 6;

function authorizedWorkflow() {
  return authorizeExport(confirmRights(createInitialWorkflow(), "tester@example.com"));
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    sourcePath: "",
    startSec: 1,
    endSec: 3,
    words: [{ text: "Bonjour", start_sec: 1.2, end_sec: 1.5, speaker: "A", confidence: 0.9 }],
    workflow: authorizedWorkflow(),
    ...overrides,
  };
}

function postRequest(body: unknown, cookie?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  return new NextRequest("http://localhost/api/export-segment", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeAuthedCookie(deps: AppDeps, email: string): string {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  return signSessionId(session.id, deps.authSecret);
}

describe("POST /api/export-segment (real ffmpeg + real ffprobe)", () => {
  let workDir: string;
  let uploadsDir: string;
  let exportsDir: string;
  let sourcePath: string;
  let appDeps: AppDeps;
  let authCookie: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-export-route-"));
    uploadsDir = path.join(workDir, "uploads");
    exportsDir = path.join(workDir, "exports");
    await mkdir(uploadsDir, { recursive: true });
    sourcePath = path.join(uploadsDir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
    appDeps = createTestAppDeps();
    authCookie = makeAuthedCookie(appDeps, "downloader@example.com");
  }, 60000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function handler() {
    return createExportSegmentHandler({ uploadsBaseDir: uploadsDir, exportsBaseDir: exportsDir }, appDeps);
  }

  it("requires an authenticated account for the final download — no account, no export", async () => {
    const POST = handler();
    const res = await POST(postRequest(requestBody({ sourcePath })));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("blocks export with 403 when the workflow is not authorized, even when authenticated", async () => {
    const POST = handler();
    const res = await POST(
      postRequest(requestBody({ sourcePath, workflow: createInitialWorkflow() }), authCookie)
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(Array.isArray(json.reasons)).toBe(true);
    expect(json.reasons.length).toBeGreaterThan(0);
  });

  it("performs a real export and verifies it with ffprobe when authenticated and authorized", async () => {
    const POST = handler();
    const res = await POST(postRequest(requestBody({ sourcePath }), authCookie));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.output.width).toBe(1080);
    expect(json.output.height).toBe(1920);
    expect(json.output.video_codec).toBe("h264");
    expect(json.output.audio_codec).toBe("aac");
    expect(json.output.duration_sec).toBeGreaterThan(1.5);
    expect(json.output.duration_sec).toBeLessThan(2.5);

    expect(typeof json.export_id).toBe("string");
    expect(json.export_id.length).toBeGreaterThan(0);
    expect(json.stored_path).toBeUndefined();

    const expectedOutputPath = path.join(exportsDir, `${json.export_id}.mp4`);
    const fileInfo = await stat(expectedOutputPath);
    expect(fileInfo.size).toBeGreaterThan(0);
  }, 30000);

  it("never reveals an absolute server filesystem path in the response", async () => {
    const POST = handler();
    const res = await POST(postRequest(requestBody({ sourcePath }), authCookie));
    const json = await res.json();
    const text = JSON.stringify(json);
    expect(text).not.toContain(workDir);
    expect(text).not.toContain(exportsDir);
    expect(text).not.toContain(uploadsDir);
  }, 30000);

  it("rejects a sourcePath outside the configured uploads directory (path traversal defense)", async () => {
    const POST = handler();
    const outsidePath = path.join(workDir, "outside.mp4");
    await writeFile(outsidePath, "not really media");
    const res = await POST(postRequest(requestBody({ sourcePath: outsidePath }), authCookie));
    expect(res.status).toBe(403);
  });

  it("returns 404 when sourcePath points to a nonexistent file inside the uploads dir", async () => {
    const POST = handler();
    const missing = path.join(uploadsDir, "missing.mp4");
    const res = await POST(postRequest(requestBody({ sourcePath: missing }), authCookie));
    expect(res.status).toBe(404);
  });

  it("blocks export when the segment end exceeds the real source duration", async () => {
    const POST = handler();
    const res = await POST(
      postRequest(requestBody({ sourcePath, startSec: 1, endSec: SOURCE_DURATION_SEC + 30 }), authCookie)
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reasons.some((r: string) => /durée/i.test(r))).toBe(true);
  });

  it("returns 400 for an invalid JSON body (once authenticated)", async () => {
    const POST = handler();
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${authCookie}`);
    const req = new NextRequest("http://localhost/api/export-segment", {
      method: "POST",
      headers,
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed request body (e.g. endSec <= startSec)", async () => {
    const POST = handler();
    const res = await POST(postRequest(requestBody({ sourcePath, startSec: 3, endSec: 1 }), authCookie));
    expect(res.status).toBe(400);
  });
});
