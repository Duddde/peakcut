// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createPreviewSegmentFileHandler } from "./route";
import { previewOutputPath } from "@/lib/ffmpeg/previewStorage";

describe("GET /api/preview-segment/[id]", () => {
  let previewsDir: string;

  beforeEach(async () => {
    previewsDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-file-"));
  });

  afterEach(async () => {
    await rm(previewsDir, { recursive: true, force: true });
  });

  function handler() {
    return createPreviewSegmentFileHandler({ previewsBaseDir: previewsDir });
  }

  async function callGet(GET: ReturnType<typeof handler>, id: string) {
    return GET(new NextRequest(`http://localhost/api/preview-segment/${id}`), {
      params: Promise.resolve({ id }),
    });
  }

  it("streams the preview bytes with a video/mp4 content-type", async () => {
    const id = randomUUID();
    await writeFile(previewOutputPath(previewsDir, id), "fake-mp4-bytes");
    const res = await callGet(handler(), id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("fake-mp4-bytes");
  });

  it("returns 404 for a nonexistent id", async () => {
    const res = await callGet(handler(), randomUUID());
    expect(res.status).toBe(404);
  });

  it("returns 404 (not a filesystem error) for a path-traversal-shaped id", async () => {
    const res = await callGet(handler(), "..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an expired preview", async () => {
    const id = randomUUID();
    const filePath = previewOutputPath(previewsDir, id);
    await writeFile(filePath, "fake-mp4-bytes");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(filePath, old, old);

    const res = await callGet(handler(), id);
    expect(res.status).toBe(404);
  });

  it("never includes the real server path in any response", async () => {
    const id = randomUUID();
    await writeFile(previewOutputPath(previewsDir, id), "fake-mp4-bytes");
    const res = await callGet(handler(), id);
    const text = JSON.stringify([...res.headers.entries()]);
    expect(text).not.toContain(previewsDir);
  });
});
