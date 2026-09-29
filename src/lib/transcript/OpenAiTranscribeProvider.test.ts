import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAiTranscribeProvider } from "./OpenAiTranscribeProvider";
import { TranscriptProviderNotConfiguredError } from "./TranscriptProvider";
import {
  LocalMediaFileNotFoundError,
  TranscriptHttpError,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
} from "./transcriptHttp";

describe("OpenAiTranscribeProvider", () => {
  let dir: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-openai-provider-"));
    mediaPath = path.join(dir, "clip.mp4");
    await writeFile(mediaPath, "fake media bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("throws TranscriptProviderNotConfiguredError without OPENAI_API_KEY, before touching fetch or the filesystem", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = vi.fn();
    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    await expect(provider.transcribe({ mediaPath: "/nonexistent/path.mp4" })).rejects.toBeInstanceOf(
      TranscriptProviderNotConfiguredError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws LocalMediaFileNotFoundError for a nonexistent local file, without calling fetch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn();
    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    await expect(
      provider.transcribe({ mediaPath: path.join(dir, "missing.mp4") })
    ).rejects.toBeInstanceOf(LocalMediaFileNotFoundError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads the local file as multipart form data with the diarized_json model, and converts a successful diarized response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          language: "fr",
          words: [
            { word: "Bonjour", start: 0, end: 0.4, speaker: "A", confidence: 0.92 },
            { word: "monde", start: 0.5, end: 0.9, speaker: "B", confidence: 0.88 },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    const transcript = await provider.transcribe({ mediaPath });

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-key-for-test-only");
    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const body = capturedInit?.body as FormData;
    expect(body.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(body.get("response_format")).toBe("diarized_json");
    expect(body.get("file")).toBeInstanceOf(Blob);

    expect(transcript.providerId).toBe("openai-gpt-4o-transcribe-diarize");
    expect(transcript.words).toHaveLength(2);
    expect(transcript.words[0].speaker).toBe("A");
    expect(transcript.words[1].speaker).toBe("B");
    expect(transcript.words[0].confidence).toBe(0.92);
  });

  it("throws TranscriptHttpError for a non-2xx HTTP response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(
      async () => new Response("invalid api key", { status: 401, statusText: "Unauthorized" })
    ) as unknown as typeof fetch;
    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptHttpError);
  });

  it("throws TranscriptTimeoutError when the request is aborted", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAiTranscribeProvider({ fetchImpl, timeoutMs: 5 });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptTimeoutError);
  });

  it("throws TranscriptInvalidPayloadError for a malformed JSON response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptInvalidPayloadError);
  });

  it("throws TranscriptInvalidPayloadError for a well-formed JSON response missing words/segments", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "no structured words here" }), { status: 200 })
    ) as unknown as typeof fetch;
    const provider = new OpenAiTranscribeProvider({ fetchImpl });
    await expect(provider.transcribe({ mediaPath })).rejects.toBeInstanceOf(TranscriptInvalidPayloadError);
  });

  it("never contacts the real network — only the injected fetchImpl is ever invoked", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const originalFetch = globalThis.fetch;
    let realFetchCalled = false;
    globalThis.fetch = () => {
      realFetchCalled = true;
      throw new Error("should not be called");
    };
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ words: [{ word: "x", start: 0, end: 0.1 }] }), { status: 200 })
      ) as unknown as typeof fetch;
      const provider = new OpenAiTranscribeProvider({ fetchImpl });
      await provider.transcribe({ mediaPath });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(realFetchCalled).toBe(false);
  });
});
