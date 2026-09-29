import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssemblyAiProvider } from "./AssemblyAiProvider";
import { TranscriptProviderNotConfiguredError } from "./TranscriptProvider";
import {
  LocalMediaFileNotFoundError,
  TranscriptHttpError,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
} from "./transcriptHttp";

const NOOP_SLEEP = async () => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("AssemblyAiProvider", () => {
  let dir: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-assemblyai-provider-"));
    mediaPath = path.join(dir, "clip.mp4");
    await writeFile(mediaPath, "fake media bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("throws TranscriptProviderNotConfiguredError without ASSEMBLYAI_API_KEY, before touching fetch", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    const fetchImpl = vi.fn();
    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(
      TranscriptProviderNotConfiguredError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws LocalMediaFileNotFoundError for a nonexistent local file, without calling fetch", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn();
    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    await expect(
      provider.transcribe({ mediaPath: path.join(dir, "missing.mp4") })
    ).rejects.toBeInstanceOf(LocalMediaFileNotFoundError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads, creates a transcript with speaker_labels, polls, and converts the completed diarized result", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/upload")) {
        return jsonResponse({ upload_url: "https://cdn.assemblyai.com/upload/abc123" });
      }
      if (url.endsWith("/transcript")) {
        return jsonResponse({ id: "transcript-1", status: "queued" });
      }
      if (url.endsWith("/transcript/transcript-1")) {
        return jsonResponse({
          status: "completed",
          language_code: "fr",
          utterances: [
            {
              speaker: "A",
              start: 0,
              end: 900,
              words: [
                { text: "Bonjour", start: 0, end: 400, confidence: 0.95 },
                { text: "monde", start: 450, end: 900, confidence: 0.9, speaker: "B" },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected URL in test: ${url}`);
    }) as unknown as typeof fetch;

    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    const transcript = await provider.transcribe({ mediaPath });

    expect(calls[0].url).toBe("https://api.assemblyai.com/v2/upload");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(
      "fake-key-for-test-only"
    );
    expect(calls[0].init?.body).toBeInstanceOf(Buffer);

    expect(calls[1].url).toBe("https://api.assemblyai.com/v2/transcript");
    const createBody = JSON.parse(calls[1].init?.body as string);
    expect(createBody.audio_url).toBe("https://cdn.assemblyai.com/upload/abc123");
    expect(createBody.speaker_labels).toBe(true);

    expect(calls[2].url).toBe("https://api.assemblyai.com/v2/transcript/transcript-1");

    expect(transcript.providerId).toBe("assemblyai");
    expect(transcript.language).toBe("fr");
    expect(transcript.words).toHaveLength(2);
    expect(transcript.words[0]).toEqual({
      text: "Bonjour",
      startSec: 0,
      endSec: 0.4,
      speaker: "A",
      confidence: 0.95,
    });
    expect(transcript.words[1].speaker).toBe("B");
  });

  it("polls multiple times while status is 'queued'/'processing' before completing", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse({ upload_url: "https://cdn/abc" });
      if (url.endsWith("/transcript")) return jsonResponse({ id: "t1", status: "queued" });
      pollCount++;
      if (pollCount < 3) return jsonResponse({ status: "processing" });
      return jsonResponse({ status: "completed", words: [{ text: "x", start: 0, end: 100, confidence: 0.9 }] });
    }) as unknown as typeof fetch;

    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP, maxPollAttempts: 10 });
    const transcript = await provider.transcribe({ mediaPath });
    expect(pollCount).toBe(3);
    expect(transcript.words).toHaveLength(1);
  });

  it("throws TranscriptInvalidPayloadError when AssemblyAI reports status 'error'", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse({ upload_url: "https://cdn/abc" });
      if (url.endsWith("/transcript")) return jsonResponse({ id: "t1", status: "queued" });
      return jsonResponse({ status: "error", error: "audio too short" });
    }) as unknown as typeof fetch;

    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptInvalidPayloadError);
  });

  it("throws TranscriptTimeoutError when polling exhausts maxPollAttempts without completing", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse({ upload_url: "https://cdn/abc" });
      if (url.endsWith("/transcript")) return jsonResponse({ id: "t1", status: "queued" });
      return jsonResponse({ status: "processing" });
    }) as unknown as typeof fetch;

    const provider = new AssemblyAiProvider({
      fetchImpl,
      sleepImpl: NOOP_SLEEP,
      maxPollAttempts: 3,
      pollIntervalMs: 1,
    });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptTimeoutError);
  });

  it("throws TranscriptHttpError when the upload step returns a non-2xx status", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 })
    ) as unknown as typeof fetch;
    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptHttpError);
  });

  it("throws TranscriptInvalidPayloadError when the upload response has no upload_url", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptInvalidPayloadError);
  });

  it("never contacts the real network — only the injected fetchImpl is ever invoked", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "fake-key-for-test-only");
    const originalFetch = globalThis.fetch;
    let realFetchCalled = false;
    globalThis.fetch = () => {
      realFetchCalled = true;
      throw new Error("should not be called");
    };
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.endsWith("/upload")) return jsonResponse({ upload_url: "https://cdn/abc" });
        if (url.endsWith("/transcript")) return jsonResponse({ id: "t1", status: "queued" });
        return jsonResponse({ status: "completed", words: [{ text: "x", start: 0, end: 100 }] });
      }) as unknown as typeof fetch;
      const provider = new AssemblyAiProvider({ fetchImpl, sleepImpl: NOOP_SLEEP });
      await provider.transcribe({ mediaPath });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(realFetchCalled).toBe(false);
  });
});
