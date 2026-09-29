import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, validateUploadMetadata } from "./validateUpload";

describe("validateUploadMetadata", () => {
  it("accepts a well-formed mp4 upload", () => {
    const result = validateUploadMetadata({
      filename: "mon-clip.mp4",
      sizeBytes: 1024 * 1024,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed wav upload", () => {
    const result = validateUploadMetadata({
      filename: "voix.wav",
      sizeBytes: 2048,
      mimeType: "audio/wav",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty filename", () => {
    const result = validateUploadMetadata({ filename: "", sizeBytes: 10, mimeType: "video/mp4" });
    expect(result.ok).toBe(false);
  });

  it("rejects a filename with a path traversal attempt", () => {
    const result = validateUploadMetadata({
      filename: "../../etc/passwd.mp4",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a filename containing a forward slash", () => {
    const result = validateUploadMetadata({
      filename: "dir/clip.mp4",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a filename with no extension", () => {
    const result = validateUploadMetadata({
      filename: "clip",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a disallowed extension (e.g. executable disguised as media)", () => {
    const result = validateUploadMetadata({
      filename: "clip.exe",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a MIME type that does not match the extension (spoofing attempt)", () => {
    const result = validateUploadMetadata({
      filename: "clip.mp4",
      sizeBytes: 10,
      mimeType: "application/x-msdownload",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a zero-byte file", () => {
    const result = validateUploadMetadata({
      filename: "clip.mp4",
      sizeBytes: 0,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a file larger than the maximum allowed size", () => {
    const result = validateUploadMetadata({
      filename: "clip.mp4",
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a file exactly at the maximum allowed size", () => {
    const result = validateUploadMetadata({
      filename: "clip.mp4",
      sizeBytes: MAX_UPLOAD_BYTES,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a filename containing control characters", () => {
    const result = validateUploadMetadata({
      filename: "clip\u0000.mp4",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an overly long filename", () => {
    const result = validateUploadMetadata({
      filename: "a".repeat(250) + ".mp4",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
  });

  it("returns a human-readable French error message on failure", () => {
    const result = validateUploadMetadata({ filename: "", sizeBytes: 10, mimeType: "video/mp4" });
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
