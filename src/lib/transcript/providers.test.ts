import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiTranscribeProvider } from "./OpenAiTranscribeProvider";
import { AssemblyAiProvider } from "./AssemblyAiProvider";
import { TranscriptProviderNotConfiguredError } from "./TranscriptProvider";
import { LocalMediaFileNotFoundError } from "./transcriptHttp";

describe("unconfigured real providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("OpenAiTranscribeProvider throws a configuration error without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = new OpenAiTranscribeProvider();
    await expect(provider.transcribe({ mediaPath: "/tmp/demo.mp4" })).rejects.toBeInstanceOf(
      TranscriptProviderNotConfiguredError
    );
  });

  it("AssemblyAiProvider throws a configuration error without ASSEMBLYAI_API_KEY", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    const provider = new AssemblyAiProvider();
    await expect(provider.transcribe({ mediaPath: "/tmp/demo.mp4" })).rejects.toBeInstanceOf(
      TranscriptProviderNotConfiguredError
    );
  });

  it("validates the local file before ever reaching the network, even once configured with a key", async () => {
    // OpenAiTranscribeProvider and AssemblyAiProvider are real adapters now (see their own
    // test files for full success/HTTP-error/timeout/payload coverage with an injected
    // fetchImpl). This test only guards the ordering: a configured-but-nonexistent local
    // file must fail via file validation, never by actually reaching the network.
    vi.stubEnv("OPENAI_API_KEY", "fake-not-a-real-key");
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("should not be called");
    };
    try {
      const provider = new OpenAiTranscribeProvider();
      await expect(
        provider.transcribe({ mediaPath: "/tmp/peakcut-does-not-exist-demo.mp4" })
      ).rejects.toBeInstanceOf(LocalMediaFileNotFoundError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});
