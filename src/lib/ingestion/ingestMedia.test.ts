import { describe, expect, it, vi } from "vitest";
import { ingestMedia, IngestionValidationError } from "./ingestMedia";
import type { MediaStorage } from "./mediaStorage";

function fakeStorage(): MediaStorage {
  return {
    save: vi.fn(async (filename: string, data: Buffer) => ({
      storedPath: `/fake/uploads/${filename}`,
      sizeBytes: data.length,
    })),
  };
}

describe("ingestMedia", () => {
  it("stores valid media and returns a fully-formed local-upload Source with an initial workflow", async () => {
    const storage = fakeStorage();
    const result = await ingestMedia(
      { filename: "clip.mp4", mimeType: "video/mp4", data: Buffer.from("fake bytes") },
      storage,
      { now: () => "2026-01-01T00:00:00.000Z", probeDurationSec: async () => 12.5 }
    );

    expect(result.source.type).toBe("local-upload");
    expect(result.source.title).toBe("clip.mp4");
    expect(result.source.localFilePath).toBe("/fake/uploads/clip.mp4");
    expect(result.source.durationSec).toBe(12.5);
    expect(result.source.originTimestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(result.source.confidence).toBe(1);
    expect(result.workflow.phase).toBe("analysis_preview");
    expect(result.workflow.publicationPolicy).toBe("publication_never_implicit");
    expect(storage.save).toHaveBeenCalledWith("clip.mp4", expect.any(Buffer));
  });

  it("rejects an invalid upload before ever touching storage", async () => {
    const storage = fakeStorage();
    await expect(
      ingestMedia(
        { filename: "virus.exe", mimeType: "video/mp4", data: Buffer.from("x") },
        storage
      )
    ).rejects.toBeInstanceOf(IngestionValidationError);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("rejects an empty buffer", async () => {
    const storage = fakeStorage();
    await expect(
      ingestMedia({ filename: "clip.mp4", mimeType: "video/mp4", data: Buffer.alloc(0) }, storage)
    ).rejects.toBeInstanceOf(IngestionValidationError);
  });

  it("falls back to a zero duration when duration probing fails, without failing ingestion", async () => {
    const storage = fakeStorage();
    const result = await ingestMedia(
      { filename: "clip.mp4", mimeType: "video/mp4", data: Buffer.from("x") },
      storage,
      {
        probeDurationSec: async () => {
          throw new Error("not a real media file");
        },
      }
    );
    expect(result.source.durationSec).toBe(0);
  });

  it("never performs network I/O (no implicit YouTube download, no upload elsewhere)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      await ingestMedia(
        { filename: "clip.mp4", mimeType: "video/mp4", data: Buffer.from("x") },
        fakeStorage()
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});
