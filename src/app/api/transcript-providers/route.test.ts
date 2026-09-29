// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/transcript-providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with id, display_name and configured for every registered provider", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.providers)).toBe(true);
    const ids = json.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("mock-deterministic");
    expect(ids).toContain("openai-gpt-4o-transcribe-diarize");
    expect(ids).toContain("assemblyai");

    for (const p of json.providers) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.display_name).toBe("string");
      expect(typeof p.configured).toBe("boolean");
    }
  });

  it("marks the mock provider as always configured", async () => {
    const res = await GET();
    const json = await res.json();
    const mock = json.providers.find((p: { id: string }) => p.id === "mock-deterministic");
    expect(mock.configured).toBe(true);
  });

  it("reflects OPENAI_API_KEY presence for the OpenAI provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const withoutKey = await (await GET()).json();
    expect(
      withoutKey.providers.find((p: { id: string }) => p.id === "openai-gpt-4o-transcribe-diarize")
        .configured
    ).toBe(false);

    vi.stubEnv("OPENAI_API_KEY", "sk-fake-for-test-only");
    const withKey = await (await GET()).json();
    expect(
      withKey.providers.find((p: { id: string }) => p.id === "openai-gpt-4o-transcribe-diarize")
        .configured
    ).toBe(true);
  });

  it("never exposes API keys, env var names, or any secret-shaped value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-super-secret-value-should-never-appear");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "another-secret-value-should-never-appear");
    const res = await GET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("sk-super-secret-value-should-never-appear");
    expect(text).not.toContain("another-secret-value-should-never-appear");
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
