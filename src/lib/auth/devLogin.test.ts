import { describe, expect, it } from "vitest";
import { isDevLoginEnabled } from "./devLogin";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe("isDevLoginEnabled", () => {
  it("is off when nothing is configured", () => {
    expect(isDevLoginEnabled(env({}))).toBe(false);
  });

  it("is on in development when explicitly set to 1", () => {
    expect(isDevLoginEnabled(env({ NODE_ENV: "development", PEAKCUT_DEV_LOGIN: "1" }))).toBe(true);
  });

  it("is on in test environments too, so it can be exercised", () => {
    expect(isDevLoginEnabled(env({ NODE_ENV: "test", PEAKCUT_DEV_LOGIN: "1" }))).toBe(true);
  });

  it("keeps password login off in production unless explicitly enabled", () => {
    expect(isDevLoginEnabled(env({ NODE_ENV: "production", PEAKCUT_DEV_LOGIN: "1" }))).toBe(false);
    expect(isDevLoginEnabled(env({ NODE_ENV: "production", PEAKCUT_PASSWORD_LOGIN: "1" }))).toBe(true);
  });

  it("only accepts the exact string \"1\", never a truthy-looking value", () => {
    for (const value of ["true", "yes", "on", "0", "", "TRUE", " 1"]) {
      expect(isDevLoginEnabled(env({ NODE_ENV: "development", PEAKCUT_DEV_LOGIN: value }))).toBe(false);
    }
  });
});
