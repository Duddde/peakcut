import { describe, expect, it } from "vitest";
import { compileAudioDuckingFilter } from "./compileAudioDuckingFilter";
import type { AudioDucking } from "./types";

function ducking(overrides: Partial<AudioDucking> = {}): AudioDucking {
  return { enabled: true, duckDb: -6, attackSec: 0.08, releaseSec: 0.4, ...overrides };
}

describe("compileAudioDuckingFilter", () => {
  it("is never applied when there is no separate background audio track, even if enabled", () => {
    const result = compileAudioDuckingFilter({ ducking: ducking(), hasBackgroundAudio: false });
    expect(result.applied).toBe(false);
    expect(result.filterFragment).toBeNull();
    expect(result.reason).toMatch(/audio de fond|background/i);
  });

  it("is never applied when ducking is disabled, even with a background track available", () => {
    const result = compileAudioDuckingFilter({
      ducking: ducking({ enabled: false }),
      hasBackgroundAudio: true,
    });
    expect(result.applied).toBe(false);
    expect(result.filterFragment).toBeNull();
  });

  it("compiles a real sidechaincompress filter_complex fragment when enabled and a background track is provided", () => {
    const result = compileAudioDuckingFilter({ ducking: ducking(), hasBackgroundAudio: true });
    expect(result.applied).toBe(true);
    expect(result.filterFragment).toContain("sidechaincompress");
    expect(result.filterFragment).toContain("[0:a]");
    expect(result.filterFragment).toContain("[1:a]");
  });

  it("rejects out-of-bounds ducking parameters rather than compiling them verbatim", () => {
    const result = compileAudioDuckingFilter({
      ducking: ducking({ duckDb: -999 }),
      hasBackgroundAudio: true,
    });
    expect(result.applied).toBe(false);
    expect(result.filterFragment).toBeNull();
    expect(result.reason).toMatch(/borne|bound/i);
  });

  it("is deterministic across calls", () => {
    const params = { ducking: ducking(), hasBackgroundAudio: true };
    expect(compileAudioDuckingFilter(params)).toEqual(compileAudioDuckingFilter(params));
  });
});
