import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalMediaStorage } from "./mediaStorage";

describe("createLocalMediaStorage (real filesystem)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-storage-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes the exact bytes given and reports the correct size", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const data = Buffer.from("fake media bytes for a test");
    const result = await storage.save("clip.mp4", data);

    expect(result.sizeBytes).toBe(data.length);
    const written = await readFile(result.storedPath);
    expect(written.equals(data)).toBe(true);
  });

  it("creates the base directory if it does not exist yet", async () => {
    const nested = path.join(baseDir, "a", "b", "uploads");
    const storage = createLocalMediaStorage(nested);
    const result = await storage.save("clip.mp4", Buffer.from("x"));
    expect(result.storedPath.startsWith(nested)).toBe(true);
  });

  it("keeps the original extension in the stored filename", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const result = await storage.save("interview.wav", Buffer.from("x"));
    expect(result.storedPath.endsWith(".wav")).toBe(true);
  });

  it("never collides when saving the same filename twice", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const first = await storage.save("clip.mp4", Buffer.from("first"));
    const second = await storage.save("clip.mp4", Buffer.from("second"));
    expect(first.storedPath).not.toBe(second.storedPath);

    const firstContent = await readFile(first.storedPath, "utf-8");
    const secondContent = await readFile(second.storedPath, "utf-8");
    expect(firstContent).toBe("first");
    expect(secondContent).toBe("second");
  });

  it("stores files strictly inside the configured base directory even for a crafted filename", async () => {
    const storage = createLocalMediaStorage(path.join(baseDir, "uploads"));
    const result = await storage.save("../../evil.mp4", Buffer.from("x"));
    const resolvedBase = path.resolve(path.join(baseDir, "uploads"));
    expect(path.resolve(result.storedPath).startsWith(resolvedBase + path.sep)).toBe(true);
  });
});
