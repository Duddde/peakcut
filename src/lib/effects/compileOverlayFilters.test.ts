import { describe, expect, it } from "vitest";
import { compileOverlayFilters, type OverlayInput } from "./compileOverlayFilters";
import { validateFilterGraph } from "./validateFilterGraph";
import type { Overlay } from "./types";

function overlay(patch: Partial<Overlay> = {}): Overlay {
  return {
    id: "ov-1",
    assetId: "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c",
    startSec: 2,
    endSec: 6,
    rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
    opacity: 0.9,
    fadeSec: 0.4,
    ...patch,
  };
}

function input(patch: Partial<Overlay> = {}, filePath = "/srv/assets/p1/a.png"): OverlayInput {
  return { overlay: overlay(patch), filePath };
}

const BASE = { outputWidth: 1080, outputHeight: 1920, baseLabel: "vbase", firstInputIndex: 1 };

describe("compileOverlayFilters", () => {
  it("compiles nothing for a clip with no illustration", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [] });
    expect(compiled).toMatchObject({ chain: null, outputLabel: "vbase", inputArgs: [], appliedCount: 0 });
  });

  it("feeds each image as a looping input, so its frames share the clip timeline", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input()] });
    expect(compiled.inputArgs).toEqual(["-loop", "1", "-i", "/srv/assets/p1/a.png"]);
  });

  it("shows the illustration only during its own window", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input()] });
    expect(compiled.chain).toContain("enable='between(t,2.000,6.000)'");
  });

  it("scales the image into its box without distorting it, and centers it there", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input()] });
    // 0.8 x 0.3 of 1080x1920
    expect(compiled.chain).toContain("scale=864:576:force_original_aspect_ratio=decrease");
    expect(compiled.chain).toContain("x='108+(864-w)/2'");
    expect(compiled.chain).toContain("y='384+(576-h)/2'");
  });

  it("fades in and out inside the illustration's own window", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input()] });
    expect(compiled.chain).toContain("fade=t=in:st=2.000:d=0.400:alpha=1");
    expect(compiled.chain).toContain("fade=t=out:st=5.600:d=0.400:alpha=1");
  });

  it("emits no fade filter at all for a hard cut", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input({ fadeSec: 0 })] });
    expect(compiled.chain).not.toContain("fade");
  });

  it("never lets a fade outrun the illustration it fades", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      overlays: [input({ startSec: 0, endSec: 1, fadeSec: 1.5 })],
    });
    expect(compiled.chain).toContain("fade=t=in:st=0.000:d=0.500:alpha=1");
    expect(compiled.chain).toContain("fade=t=out:st=0.500:d=0.500:alpha=1");
  });

  it("applies the plan's opacity", () => {
    const compiled = compileOverlayFilters({ ...BASE, overlays: [input({ opacity: 0.5 })] });
    expect(compiled.chain).toContain("colorchannelmixer=aa=0.500");
  });

  it("chains several illustrations, each over the result of the last", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      overlays: [input({ id: "a" }, "/srv/a.png"), input({ id: "b" }, "/srv/b.png")],
    });
    expect(compiled.appliedCount).toBe(2);
    expect(compiled.outputLabel).toBe("ovout1");
    expect(compiled.chain).toContain("[vbase][ovsrc0]overlay=");
    expect(compiled.chain).toContain("[ovout0][ovsrc1]overlay=");
    expect(compiled.inputArgs).toEqual(["-loop", "1", "-i", "/srv/a.png", "-loop", "1", "-i", "/srv/b.png"]);
  });

  it("numbers the ffmpeg inputs from the index it was given", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      firstInputIndex: 3,
      overlays: [input({ id: "a" }), input({ id: "b" })],
    });
    expect(compiled.chain).toContain("[3:v]scale=");
    expect(compiled.chain).toContain("[4:v]scale=");
  });

  it("skips an illustration too small to be seen, and says so, rather than emitting a 0px scale", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      overlays: [input({ rect: { x: 0, y: 0, width: 0.0005, height: 0.0005 } })],
    });
    expect(compiled).toMatchObject({ chain: null, appliedCount: 0, inputArgs: [] });
    expect(compiled.notes[0]).toMatch(/pixels/);
  });

  it("does not shift the input numbering when an illustration is skipped", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      overlays: [
        input({ id: "tiny", rect: { x: 0, y: 0, width: 0.0005, height: 0.0005 } }),
        input({ id: "real" }, "/srv/real.png"),
      ],
    });
    expect(compiled.appliedCount).toBe(1);
    expect(compiled.inputArgs).toEqual(["-loop", "1", "-i", "/srv/real.png"]);
    expect(compiled.chain).toContain("[1:v]scale=");
  });

  it("produces a filtergraph the independent validator accepts", () => {
    const compiled = compileOverlayFilters({
      ...BASE,
      overlays: [input({ id: "a" }), input({ id: "b", startSec: 7, endSec: 12 })],
    });
    expect(validateFilterGraph(compiled.chain!)).toEqual({ ok: true, errors: [] });
  });
});
