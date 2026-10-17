import { describe, expect, it } from "vitest";
import {
  MAX_ASSET_BYTES,
  isValidAssetId,
  isValidProjectId,
  sniffImageMimeType,
  validateImageAsset,
} from "./imageAsset";

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(sizeBytes = 256): Buffer {
  const data = Buffer.alloc(sizeBytes);
  Buffer.from(PNG_HEADER).copy(data);
  return data;
}

function jpeg(): Buffer {
  const data = Buffer.alloc(256);
  Buffer.from([0xff, 0xd8, 0xff]).copy(data);
  return data;
}

function webp(): Buffer {
  const data = Buffer.alloc(256);
  data.write("RIFF", 0, "ascii");
  data.write("WEBP", 8, "ascii");
  return data;
}

describe("sniffImageMimeType", () => {
  it("recognizes the three formats PeakCut accepts, by signature", () => {
    expect(sniffImageMimeType(png())).toBe("image/png");
    expect(sniffImageMimeType(jpeg())).toBe("image/jpeg");
    expect(sniffImageMimeType(webp())).toBe("image/webp");
  });

  it("returns null for anything else, including a text file named .png", () => {
    expect(sniffImageMimeType(Buffer.from("du texte, pas une image"))).toBeNull();
  });

  it("does not take a RIFF container that is not WEBP for one", () => {
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    expect(sniffImageMimeType(wav)).toBeNull();
  });
});

describe("validateImageAsset", () => {
  it("accepts a real image and reports the type it actually is", () => {
    expect(validateImageAsset({ data: png(), declaredMimeType: "image/png" })).toEqual({
      ok: true,
      mimeType: "image/png",
    });
  });

  it("trusts the bytes, not the declaration: a mismatch is refused", () => {
    expect(validateImageAsset({ data: png(), declaredMimeType: "image/jpeg" }).ok).toBe(false);
  });

  it("accepts bytes with no declared type at all (a generated image declares nothing)", () => {
    expect(validateImageAsset({ data: jpeg() })).toEqual({ ok: true, mimeType: "image/jpeg" });
  });

  it("refuses a file that is not an image, whatever it claims to be", () => {
    const result = validateImageAsset({
      // Long enough to clear the size floor: what must reject it here is
      // the signature check, not the "too small" rule.
      data: Buffer.from("du texte quelconque, pas une image du tout".padEnd(200, " ")),
      declaredMimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non reconnu/i);
  });

  it("refuses an image above the size cap", () => {
    expect(validateImageAsset({ data: png(MAX_ASSET_BYTES + 1) }).ok).toBe(false);
  });

  it("refuses an empty file", () => {
    expect(validateImageAsset({ data: Buffer.alloc(0) }).ok).toBe(false);
  });
});

describe("id checks", () => {
  it("accepts a uuid as an asset id and nothing else", () => {
    expect(isValidAssetId("1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c")).toBe(true);
    expect(isValidAssetId("../../etc/passwd")).toBe(false);
    expect(isValidAssetId("short")).toBe(false);
  });

  it("refuses any project id that could walk out of the store", () => {
    expect(isValidProjectId("p1")).toBe(true);
    expect(isValidProjectId("..")).toBe(false);
    expect(isValidProjectId("a/b")).toBe(false);
    expect(isValidProjectId("a\b")).toBe(false);
  });
});
