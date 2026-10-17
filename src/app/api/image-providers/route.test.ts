// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/image-providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns id, display_name and configured for every registered generator", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.providers.map((p: { id: string }) => p.id)).toContain("openai-gpt-image-1");
    for (const p of json.providers) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.display_name).toBe("string");
      expect(typeof p.configured).toBe("boolean");
    }
  });

  it("reports nothing as usable until a key is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const json = await (await GET()).json();
    expect(json.providers.every((p: { configured: boolean }) => !p.configured)).toBe(true);

    vi.stubEnv("OPENAI_API_KEY", "sk-fake-for-test-only");
    const withKey = await (await GET()).json();
    expect(withKey.providers.find((p: { id: string }) => p.id === "openai-gpt-image-1").configured).toBe(
      true
    );
  });

  it("never exposes a key, an env var name, or any secret-shaped value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-super-secret-value-should-never-appear");
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toContain("sk-super-secret-value-should-never-appear");
    expect(text.toLowerCase()).not.toContain("api_key");
    expect(text.toLowerCase()).not.toContain("apikey");
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
