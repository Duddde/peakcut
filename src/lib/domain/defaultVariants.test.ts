import { describe, expect, it } from "vitest";
import { buildDefaultVariants } from "./defaultVariants";

describe("buildDefaultVariants", () => {
  it("produces exactly the four standard aspect ratios", () => {
    const variants = buildDefaultVariants("seg-1");
    expect(variants.map((v) => v.aspectRatio).sort()).toEqual(["1:1", "16:9", "4:5", "9:16"].sort());
  });

  it("gives the 16:9 (source) variant the full, uncropped frame", () => {
    const variants = buildDefaultVariants("seg-1");
    const wide = variants.find((v) => v.aspectRatio === "16:9")!;
    expect(wide.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("centers narrower-than-source crops horizontally", () => {
    const variants = buildDefaultVariants("seg-1");
    const vertical = variants.find((v) => v.aspectRatio === "9:16")!;
    expect(vertical.crop.width).toBeLessThan(1);
    expect(vertical.crop.height).toBe(1);
    expect(vertical.crop.x).toBeCloseTo((1 - vertical.crop.width) / 2, 4);
  });

  it("derives stable, unique ids from the owner id", () => {
    const variants = buildDefaultVariants("seg-42");
    for (const v of variants) {
      expect(v.id.startsWith("seg-42-variant-")).toBe(true);
    }
    const ids = new Set(variants.map((v) => v.id));
    expect(ids.size).toBe(variants.length);
  });

  it("is deterministic across calls", () => {
    expect(buildDefaultVariants("seg-1")).toEqual(buildDefaultVariants("seg-1"));
  });
});
