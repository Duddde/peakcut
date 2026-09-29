import { describe, expect, it } from "vitest";
import { checkPlatformVariant, PLATFORM_VARIANTS } from "./variants";
import { EXPORT_WIDTH, EXPORT_HEIGHT } from "@/lib/ffmpeg/exportSpec";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";

const FULL_SAFE_ZONES = buildDefaultSafeZones("seg");

describe("PLATFORM_VARIANTS", () => {
  it("declares tiktok and shorts, both matching PeakCut's fixed export dimensions", () => {
    expect(PLATFORM_VARIANTS.tiktok.widthPx).toBe(EXPORT_WIDTH);
    expect(PLATFORM_VARIANTS.tiktok.heightPx).toBe(EXPORT_HEIGHT);
    expect(PLATFORM_VARIANTS.shorts.widthPx).toBe(EXPORT_WIDTH);
    expect(PLATFORM_VARIANTS.shorts.heightPx).toBe(EXPORT_HEIGHT);
  });

  it("declares h264/aac codecs matching the real export pipeline", () => {
    expect(PLATFORM_VARIANTS.tiktok.videoCodec).toBe("h264");
    expect(PLATFORM_VARIANTS.tiktok.audioCodec).toBe("aac");
    expect(PLATFORM_VARIANTS.shorts.videoCodec).toBe("h264");
    expect(PLATFORM_VARIANTS.shorts.audioCodec).toBe("aac");
  });

  it("gives Shorts a stricter maximum duration than TikTok", () => {
    expect(PLATFORM_VARIANTS.shorts.maxDurationSec).toBeLessThan(PLATFORM_VARIANTS.tiktok.maxDurationSec);
  });
});

describe("checkPlatformVariant", () => {
  it("passes for a normal short segment with full safe zones on both platforms", () => {
    for (const variantId of ["tiktok", "shorts"] as const) {
      const result = checkPlatformVariant({
        variantId,
        durationSec: 30,
        safeZones: FULL_SAFE_ZONES,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects a segment longer than the Shorts maximum duration", () => {
    const result = checkPlatformVariant({
      variantId: "shorts",
      durationSec: 90,
      safeZones: FULL_SAFE_ZONES,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /dur/i.test(e))).toBe(true);
  });

  it("accepts a 90s segment on TikTok (higher duration ceiling)", () => {
    const result = checkPlatformVariant({
      variantId: "tiktok",
      durationSec: 90,
      safeZones: FULL_SAFE_ZONES,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a segment shorter than the minimum duration", () => {
    const result = checkPlatformVariant({
      variantId: "shorts",
      durationSec: 0.2,
      safeZones: FULL_SAFE_ZONES,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a segment missing a required safe zone", () => {
    const result = checkPlatformVariant({
      variantId: "tiktok",
      durationSec: 20,
      safeZones: FULL_SAFE_ZONES.filter((z) => z.purpose !== "subtitle-area"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /zone/i.test(e))).toBe(true);
  });

  it("rejects a title longer than the platform's metadata limit", () => {
    const result = checkPlatformVariant({
      variantId: "shorts",
      durationSec: 20,
      safeZones: FULL_SAFE_ZONES,
      title: "x".repeat(500),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /titre/i.test(e))).toBe(true);
  });

  it("accepts a title within the platform's metadata limit", () => {
    const result = checkPlatformVariant({
      variantId: "shorts",
      durationSec: 20,
      safeZones: FULL_SAFE_ZONES,
      title: "Titre court",
    });
    expect(result.ok).toBe(true);
  });

  it("collects every error at once rather than stopping at the first", () => {
    const result = checkPlatformVariant({
      variantId: "shorts",
      durationSec: 999,
      safeZones: [],
      title: "x".repeat(500),
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("throws for an unknown variant id", () => {
    // @ts-expect-error intentionally invalid variant id
    expect(() => checkPlatformVariant({ variantId: "instagram", durationSec: 10, safeZones: [] })).toThrow();
  });
});
