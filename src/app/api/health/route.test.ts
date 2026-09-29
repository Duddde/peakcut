// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with a minimal ok payload", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.service).toBe("peakcut");
    expect(typeof json.version).toBe("string");
    expect(json.version.length).toBeGreaterThan(0);
    expect(json.checks).toEqual({ app: true });
  });

  it("never includes secret-shaped fields (api keys, tokens, env values)", async () => {
    const res = await GET();
    const text = JSON.stringify(await res.json()).toLowerCase();
    expect(text).not.toContain("key");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
  });

  it("performs no network I/O", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      await GET();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});
