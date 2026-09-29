import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderConfigured } from "./providerConfiguration";

describe("isProviderConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is always true for the deterministic mock provider", () => {
    expect(isProviderConfigured("mock-deterministic")).toBe(true);
  });

  it("is false for OpenAI when OPENAI_API_KEY is unset", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(isProviderConfigured("openai-gpt-4o-transcribe-diarize")).toBe(false);
  });

  it("is true for OpenAI once OPENAI_API_KEY is set", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-fake-for-test-only");
    expect(isProviderConfigured("openai-gpt-4o-transcribe-diarize")).toBe(true);
  });

  it("is false for AssemblyAI when ASSEMBLYAI_API_KEY is unset", () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    expect(isProviderConfigured("assemblyai")).toBe(false);
  });

  it("is true for AssemblyAI once ASSEMBLYAI_API_KEY is set", () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-for-test-only");
    expect(isProviderConfigured("assemblyai")).toBe(true);
  });

  it("is false for an unknown provider id", () => {
    expect(isProviderConfigured("some-unknown-provider")).toBe(false);
  });
});
