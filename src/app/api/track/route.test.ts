// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTrackHandler } from "./route";
import { createSyntheticVideo } from "../../../../test/fixtures/createSyntheticVideo";
import type { FrameTracker } from "@/lib/tracking/types";

const SOURCE_DURATION_SEC = 4;

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/track", () => {
  let workDir: string;
  let uploadsDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-track-route-"));
    uploadsDir = path.join(workDir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    sourcePath = path.join(uploadsDir, "source.mp4");
    await createSyntheticVideo(sourcePath, SOURCE_DURATION_SEC);
  }, 30000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function handler(trackerFactory?: (providerId: string) => FrameTracker) {
    return createTrackHandler({ uploadsBaseDir: uploadsDir, trackerFactory });
  }

  it("returns 400 for invalid JSON", async () => {
    const POST = handler();
    const req = new NextRequest("http://localhost/api/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("returns 400 for an unknown provider", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, provider: "magic-ai" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a sourcePath containing a path traversal segment", async () => {
    const POST = handler();
    const res = await POST(
      postRequest({ sourcePath: "../../etc/passwd", provider: "stable-center-fallback" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when sourcePath resolves outside the configured uploads directory", async () => {
    const POST = handler();
    const outside = path.join(workDir, "outside.mp4");
    await writeFile(outside, "x");
    const res = await POST(postRequest({ sourcePath: outside, provider: "stable-center-fallback" }));
    expect(res.status).toBe(403);
  });

  it("returns 404 when sourcePath points to a nonexistent file inside the uploads dir", async () => {
    const POST = handler();
    const missing = path.join(uploadsDir, "missing.mp4");
    const res = await POST(postRequest({ sourcePath: missing, provider: "stable-center-fallback" }));
    expect(res.status).toBe(404);
  });

  it("performs a real end-to-end stable-center-fallback track (real ffprobe, real tracker)", async () => {
    const POST = handler(); // default registry — no injection, exercises the real StableCenterFrameTracker
    const res = await POST(postRequest({ sourcePath, provider: "stable-center-fallback" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.provider).toBe("stable-center-fallback");
    expect(json.track.fallback_used).toBe(true);
    expect(json.track.method).toContain("centered");
    expect(json.track.keyframes.length).toBeGreaterThan(0);
    expect(json.track.keyframes[0]).toHaveProperty("cx");
    expect(json.track.keyframes[0]).toHaveProperty("cy");
    expect(json.track.keyframes[0]).toHaveProperty("confidence");
  }, 30000);

  it("reports fallback_used: false and real confidence when the injected tracker returns a real detection", async () => {
    const fakeTracker: FrameTracker = {
      id: "local-subject",
      displayName: "fake",
      track: async () => ({
        keyframes: [{ tSec: 0, cx: 0.6, cy: 0.4, confidence: 0.88 }],
        fallbackUsed: false,
        method: "local-subject-detection",
      }),
    };
    const POST = handler((id) => {
      expect(id).toBe("local-subject");
      return fakeTracker;
    });
    const res = await POST(postRequest({ sourcePath, provider: "local-subject" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.track.fallback_used).toBe(false);
    expect(json.track.method).toBe("local-subject-detection");
    expect(json.track.keyframes[0].confidence).toBe(0.88);
  }, 30000);

  it("returns 503 when local-subject is requested but no external tracker command is configured", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "");
    const POST = handler(); // real registry: LocalSubjectTracker + CommandSubjectDetectionEngine, unconfigured
    const res = await POST(postRequest({ sourcePath, provider: "local-subject" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
  }, 30000);

  it("never reveals an absolute server filesystem path in the response", async () => {
    const POST = handler();
    const res = await POST(postRequest({ sourcePath, provider: "stable-center-fallback" }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(workDir);
    expect(text).not.toContain(uploadsDir);
  }, 30000);
});
