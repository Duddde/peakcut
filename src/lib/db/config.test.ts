import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseConfigError, getDbConfig } from "./config";

describe("getDbConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws DatabaseConfigError when PEAKCUT_DB_PATH is unset", () => {
    vi.stubEnv("PEAKCUT_DB_PATH", "");
    expect(() => getDbConfig()).toThrow(DatabaseConfigError);
  });

  it("returns the configured path", () => {
    vi.stubEnv("PEAKCUT_DB_PATH", "/tmp/peakcut-test.db");
    expect(getDbConfig()).toEqual({ path: "/tmp/peakcut-test.db" });
  });

  it("throws for a whitespace-only path", () => {
    vi.stubEnv("PEAKCUT_DB_PATH", "   ");
    expect(() => getDbConfig()).toThrow(DatabaseConfigError);
  });
});
