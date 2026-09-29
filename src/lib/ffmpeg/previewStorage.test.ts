// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  cleanupExpiredPreviews,
  getFreshPreviewFile,
  isValidPreviewId,
  previewOutputPath,
} from "./previewStorage";

describe("previewStorage", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-preview-storage-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("isValidPreviewId accepts a real UUID and rejects path-traversal-shaped input", () => {
    expect(isValidPreviewId(randomUUID())).toBe(true);
    expect(isValidPreviewId("../../etc/passwd")).toBe(false);
    expect(isValidPreviewId("not-a-uuid")).toBe(false);
    expect(isValidPreviewId("")).toBe(false);
  });

  it("getFreshPreviewFile returns null for a nonexistent id", async () => {
    const result = await getFreshPreviewFile(baseDir, randomUUID());
    expect(result).toBeNull();
  });

  it("getFreshPreviewFile returns null for a malformed id without ever touching the filesystem", async () => {
    const result = await getFreshPreviewFile(baseDir, "../../etc/passwd");
    expect(result).toBeNull();
  });

  it("getFreshPreviewFile returns the file path and an expiry when within TTL", async () => {
    const id = randomUUID();
    await writeFile(previewOutputPath(baseDir, id), "fake-mp4-bytes");
    const result = await getFreshPreviewFile(baseDir, id, 1000, Date.now());
    expect(result?.filePath).toBe(previewOutputPath(baseDir, id));
    expect(result?.expiresAt).toBeTruthy();
  });

  it("getFreshPreviewFile returns null and deletes the file once past TTL", async () => {
    const id = randomUUID();
    const filePath = previewOutputPath(baseDir, id);
    await writeFile(filePath, "fake-mp4-bytes");
    const old = new Date(Date.now() - 60_000);
    await utimes(filePath, old, old);

    const result = await getFreshPreviewFile(baseDir, id, 1000, Date.now());
    expect(result).toBeNull();
    await expect(getFreshPreviewFile(baseDir, id, 100_000, Date.now())).resolves.toBeNull();
  });

  it("cleanupExpiredPreviews removes only files older than the TTL", async () => {
    const freshId = randomUUID();
    const staleId = randomUUID();
    await writeFile(previewOutputPath(baseDir, freshId), "fresh");
    const stalePath = previewOutputPath(baseDir, staleId);
    await writeFile(stalePath, "stale");
    const old = new Date(Date.now() - 60_000);
    await utimes(stalePath, old, old);

    await cleanupExpiredPreviews(baseDir, 1000, Date.now());

    expect(await getFreshPreviewFile(baseDir, freshId, 100_000)).not.toBeNull();
    expect(await getFreshPreviewFile(baseDir, staleId, 100_000)).toBeNull();
  });

  it("cleanupExpiredPreviews is a no-op when the directory doesn't exist yet", async () => {
    await expect(cleanupExpiredPreviews(path.join(baseDir, "does-not-exist"))).resolves.toBeUndefined();
  });
});
