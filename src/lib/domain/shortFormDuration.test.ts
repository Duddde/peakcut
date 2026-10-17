import { describe, expect, it } from "vitest";
import {
  IDEAL_MAX_SEC,
  IDEAL_MIN_SEC,
  MIN_VIABLE_SEC,
  TOO_LONG_SEC,
  shortFormDurationFactor,
} from "./shortFormDuration";

describe("shortFormDurationFactor", () => {
  it("targets a clip of about a minute", () => {
    expect(IDEAL_MIN_SEC).toBeLessThanOrEqual(60);
    expect(IDEAL_MAX_SEC).toBeGreaterThanOrEqual(90);
    expect(shortFormDurationFactor(60)).toBe(1);
    expect(shortFormDurationFactor(75)).toBe(1);
    expect(shortFormDurationFactor(90)).toBe(1);
  });

  it("is flat at 1 across the whole plateau and nowhere else", () => {
    expect(shortFormDurationFactor(IDEAL_MIN_SEC)).toBe(1);
    expect(shortFormDurationFactor(IDEAL_MAX_SEC)).toBe(1);
    expect(shortFormDurationFactor(IDEAL_MIN_SEC - 0.5)).toBeLessThan(1);
    expect(shortFormDurationFactor(IDEAL_MAX_SEC + 0.5)).toBeLessThan(1);
  });

  it("rises monotonically up to the plateau and falls monotonically after it", () => {
    for (let d = MIN_VIABLE_SEC; d < IDEAL_MIN_SEC; d += 1) {
      expect(shortFormDurationFactor(d + 1)).toBeGreaterThan(shortFormDurationFactor(d));
    }
    for (let d = IDEAL_MAX_SEC; d < TOO_LONG_SEC - 1; d += 1) {
      expect(shortFormDurationFactor(d + 1)).toBeLessThan(shortFormDurationFactor(d));
    }
  });

  it("scores a fragment and an over-long cut at 0", () => {
    expect(shortFormDurationFactor(0)).toBe(0);
    expect(shortFormDurationFactor(MIN_VIABLE_SEC)).toBe(0);
    expect(shortFormDurationFactor(TOO_LONG_SEC)).toBe(0);
    expect(shortFormDurationFactor(10_000)).toBe(0);
  });

  it("stays in [0, 1] for anything, including garbage input", () => {
    for (const d of [-10, 0, 1, 47, 61, 300, Number.NaN, Number.POSITIVE_INFINITY]) {
      const factor = shortFormDurationFactor(d);
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });
});
