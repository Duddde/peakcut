import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthConfigError, getAuthSecret } from "./authConfig";

describe("getAuthSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws AuthConfigError when PEAKCUT_AUTH_SECRET is unset", () => {
    vi.stubEnv("PEAKCUT_AUTH_SECRET", "");
    expect(() => getAuthSecret()).toThrow(AuthConfigError);
  });

  it("throws AuthConfigError when the secret is too short", () => {
    vi.stubEnv("PEAKCUT_AUTH_SECRET", "short");
    expect(() => getAuthSecret()).toThrow(AuthConfigError);
  });

  it("returns a sufficiently long configured secret", () => {
    vi.stubEnv("PEAKCUT_AUTH_SECRET", "a".repeat(32));
    expect(getAuthSecret()).toBe("a".repeat(32));
  });

  it("never includes the secret value in its own error messages", () => {
    vi.stubEnv("PEAKCUT_AUTH_SECRET", "short");
    try {
      getAuthSecret();
    } catch (err) {
      expect((err as Error).message).not.toContain("short");
    }
  });
});
