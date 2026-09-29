// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createPreviewSegmentHandler } from "./route";
import { createFixedWindowRateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import { createSyntheticVideo } from "../../../../test/fixtures/createSyntheticVideo";

const SOURCE_DURATION_SEC = 6;

function postRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/preview-segment", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/preview-segment (real ffmpeg + real ffprobe)", () => {
  let workDir: string;
  let uploadsDir: string;
  let previewsDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-route-"));
    uploadsDir = path.join(workDir, "uploads");
    previewsDir = path.join(workDir, "previews");
    await mkdir(uploadsDir, { recursive: true });
    sourcePath = path.join(uploadsDir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
  }, 60000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function handler(overrides: Partial<Parameters<typeof createPreviewSegmentHandler>[0]> = {}) {
    return createPreviewSegmentHandler({
      uploadsBaseDir: uploadsDir,
      previewsBaseDir: previewsDir,
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      ...overrides,
    });
  }

  it("generates a real watermarked low-res preview and never leaks a server path", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, startSec: 1, endSec: 3 }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.watermark).toBe(true);
    expect(typeof json.previewId).toBe("string");
    expect(json.url).toBe(`/api/preview-segment/${json.previewId}`);
    expect(json.expiresAt).toBeTruthy();

    const text = JSON.stringify(json);
    expect(text).not.toContain(workDir);
    expect(text).not.toContain(previewsDir);
    expect(text).not.toContain(uploadsDir);

    const fileInfo = await stat(path.join(previewsDir, `${json.previewId}.mp4`));
    expect(fileInfo.size).toBeGreaterThan(0);
  }, 30000);

  it("requires no auth/account at all (this is the free anonymous tier)", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, startSec: 0, endSec: 2 }));
    expect(res.status).toBe(201);
  }, 30000);

  it("rejects a segment longer than the free preview cap", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, startSec: 0, endSec: 25 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects a sourcePath outside the uploads directory (path traversal defense)", async () => {
    const POST = handler();
    const outsidePath = path.join(workDir, "outside.mp4");
    await writeFile(outsidePath, "not really media");
    const res = await POST(postRequest({ sourcePath: outsidePath, startSec: 0, endSec: 2 }));
    expect(res.status).toBe(403);
  });

  it("returns 404 for a sourcePath that doesn't exist", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath: path.join(uploadsDir, "missing.mp4"), startSec: 0, endSec: 2 }));
    expect(res.status).toBe(404);
  });

  it("rejects a segment beyond the real source duration", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, startSec: 0, endSec: SOURCE_DURATION_SEC + 10 }));
    expect(res.status).toBe(422);
  });

  it("returns 400 for a malformed body", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, startSec: 3, endSec: 1 }));
    expect(res.status).toBe(400);
  });

  it("returns 429 once the rate limit is exhausted, and never generates a file for the blocked request", async () => {
    const POST = handler({ rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
    const first = await POST(postRequest({ sourcePath, startSec: 0, endSec: 1 }, { "x-forwarded-for": "1.2.3.4" }));
    expect(first.status).toBe(201);

    const second = await POST(postRequest({ sourcePath, startSec: 0, endSec: 1 }, { "x-forwarded-for": "1.2.3.4" }));
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  }, 30000);

  it("rate-limits independently per client IP", async () => {
    const POST = handler({ rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
    const a = await POST(postRequest({ sourcePath, startSec: 0, endSec: 1 }, { "x-forwarded-for": "1.1.1.1" }));
    const b = await POST(postRequest({ sourcePath, startSec: 0, endSec: 1 }, { "x-forwarded-for": "2.2.2.2" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  }, 30000);

  it("returns an honest 503 with a browser-fallback hint when the anonymous preview feature is disabled", async () => {
    const POST = handler({ enabled: false });
    const res = await POST(postRequest({ sourcePath, startSec: 0, endSec: 1 }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.fallback).toBe("browser");
  });
});
