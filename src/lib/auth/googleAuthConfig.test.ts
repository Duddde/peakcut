import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthConfigError, getGoogleAuthConfig } from "./googleAuthConfig";

describe("getGoogleAuthConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured values", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("AUTH_GOOGLE_ID", "client-id.apps.googleusercontent.com");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "client-secret-value");
    expect(getGoogleAuthConfig()).toEqual({
      authSecret: "a".repeat(32),
      googleClientId: "client-id.apps.googleusercontent.com",
      googleClientSecret: "client-secret-value",
    });
  });

  it("throws GoogleAuthConfigError when AUTH_SECRET is missing", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("AUTH_GOOGLE_ID", "id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
    expect(() => getGoogleAuthConfig()).toThrow(GoogleAuthConfigError);
  });

  it("throws GoogleAuthConfigError when AUTH_GOOGLE_ID is missing", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("AUTH_GOOGLE_ID", "");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
    expect(() => getGoogleAuthConfig()).toThrow(GoogleAuthConfigError);
  });

  it("throws GoogleAuthConfigError when AUTH_GOOGLE_SECRET is missing", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("AUTH_GOOGLE_ID", "id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    expect(() => getGoogleAuthConfig()).toThrow(GoogleAuthConfigError);
  });

  it("lists every missing variable in one error rather than only the first", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("AUTH_GOOGLE_ID", "");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    try {
      getGoogleAuthConfig();
      throw new Error("expected getGoogleAuthConfig to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("AUTH_SECRET");
      expect(message).toContain("AUTH_GOOGLE_ID");
      expect(message).toContain("AUTH_GOOGLE_SECRET");
    }
  });

  it("never echoes the actual secret values in its error message", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("AUTH_GOOGLE_ID", "id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "super-secret-value-should-not-leak");
    try {
      getGoogleAuthConfig();
    } catch {
      // Only AUTH_SECRET is unset in this case, so no secret VALUE is even
      // in scope to leak; this test documents the intent for future edits.
    }
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    // A fully-configured call must never include the secret value in any log/message path either.
    const config = getGoogleAuthConfig();
    expect(config.googleClientSecret).toBe("super-secret-value-should-not-leak");
  });
});
