// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeFilterPath, drawtextFontFragment, resolveWatermarkFont } from "./renderPreviewSegment";

const never = () => false;
const always = () => true;

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveWatermarkFont", () => {
  it("prefers PEAKCUT_WATERMARK_FONT over the platform's standard fonts", () => {
    const font = resolveWatermarkFont({
      env: env({ PEAKCUT_WATERMARK_FONT: "/opt/fonts/Brand.ttf" }),
      platform: "linux",
      fileExists: always,
    });
    expect(font).toBe("/opt/fonts/Brand.ttf");
  });

  it("ignores a configured font that is not on disk rather than passing ffmpeg a dead path", () => {
    const font = resolveWatermarkFont({
      env: env({ PEAKCUT_WATERMARK_FONT: "/opt/fonts/absent.ttf" }),
      platform: "linux",
      fileExists: never,
    });
    expect(font).toBeNull();
  });

  it("picks the first existing candidate for the platform", () => {
    const font = resolveWatermarkFont({
      env: env({}),
      platform: "win32",
      fileExists: (p) => p === "C:/Windows/Fonts/tahoma.ttf",
    });
    expect(font).toBe("C:/Windows/Fonts/tahoma.ttf");
  });

  it("falls back to fontconfig (null) when no candidate exists", () => {
    expect(resolveWatermarkFont({ env: env({}), platform: "linux", fileExists: never })).toBeNull();
  });

  it("treats an unknown platform as linux", () => {
    const font = resolveWatermarkFont({
      env: env({}),
      platform: "freebsd",
      fileExists: (p) => p === "/usr/share/fonts/TTF/DejaVuSans.ttf",
    });
    expect(font).toBe("/usr/share/fonts/TTF/DejaVuSans.ttf");
  });
});

describe("escapeFilterPath", () => {
  it("escapes a Windows drive colon, which ffmpeg would read as an option separator", () => {
    expect(escapeFilterPath("C:\\Windows\\Fonts\\arial.ttf")).toBe("C\\:/Windows/Fonts/arial.ttf");
  });

  it("leaves a POSIX path alone", () => {
    expect(escapeFilterPath("/usr/share/fonts/TTF/DejaVuSans.ttf")).toBe("/usr/share/fonts/TTF/DejaVuSans.ttf");
  });
});

describe("drawtextFontFragment", () => {
  it("builds the fontfile prefix when a font is available", () => {
    const fragment = drawtextFontFragment({
      env: env({ PEAKCUT_WATERMARK_FONT: "C:\\Windows\\Fonts\\arial.ttf" }),
      platform: "win32",
      fileExists: always,
    });
    expect(fragment).toBe("fontfile='C\\:/Windows/Fonts/arial.ttf':");
  });

  it("is empty when nothing is available, leaving the filter exactly as before", () => {
    expect(drawtextFontFragment({ env: env({}), platform: "linux", fileExists: never })).toBe("");
  });
});
