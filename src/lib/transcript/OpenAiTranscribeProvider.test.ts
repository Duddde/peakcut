// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAiTranscribeProvider, OPENAI_MAX_UPLOAD_BYTES } from "./OpenAiTranscribeProvider";
import { TranscriptProviderNotConfiguredError } from "./TranscriptProvider";
import {
  LocalMediaFileNotFoundError,
  TranscriptHttpError,
  TranscriptInvalidPayloadError,
  TranscriptMediaTooLargeError,
  TranscriptTimeoutError,
} from "./transcriptHttp";
import type { ExtractedAudio } from "@/lib/ffmpeg/extractAudioForTranscription";

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
    const body = capturedInit?.body as FormData;
    expect(body.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(body.get("response_format")).toBe("diarized_json");
    // Without it the endpoint answers 400 "chunking_strategy is required
    // for diarization models" — the whole request is wasted.
    expect(body.get("chunking_strategy")).toBe("auto");
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

describe("OpenAiTranscribeProvider — média au-delà de la limite d'upload", () => {
  let dir: string;
  let bigMediaPath: string;

  /** A real 20-minute 1080p download is tens of megabytes; the endpoint refuses anything over 25 MiB. */
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-openai-big-"));
    bigMediaPath = path.join(dir, "long-video.mp4");
    await writeFile(bigMediaPath, Buffer.alloc(OPENAI_MAX_UPLOAD_BYTES + 1024));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function fakeExtraction(sizeBytes: number) {
    const audioPath = path.join(dir, "extrait.mp3");
    await writeFile(audioPath, Buffer.alloc(sizeBytes));
    const cleanup = vi.fn(async () => {
      await rm(audioPath, { force: true });
    });
    const extractAudio = vi.fn(async (): Promise<ExtractedAudio> => ({ path: audioPath, sizeBytes, cleanup }));
    return { audioPath, cleanup, extractAudio };
  }

  function okFetch() {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({ language: "fr", words: [{ word: "Bonjour", start: 0, end: 0.4, speaker: "A", confidence: 0.9 }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, captured: () => capturedInit };
  }

  it("extracts the audio track and uploads that instead of the video", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const { extractAudio, cleanup } = await fakeExtraction(2 * 1024 * 1024);
    const { fetchImpl, captured } = okFetch();

    const transcript = await new OpenAiTranscribeProvider({ fetchImpl, extractAudio }).transcribe({
      mediaPath: bigMediaPath,
    });

    expect(extractAudio).toHaveBeenCalledWith(bigMediaPath);
    expect(transcript.words).toHaveLength(1);

    const body = captured()?.body as FormData;
    const uploaded = body.get("file") as File;
    expect(uploaded.name).toBe("extrait.mp3");
    expect(uploaded.size).toBe(2 * 1024 * 1024);

    // The temporary copy of the user's audio never outlives the request.
    expect(cleanup).toHaveBeenCalled();
  });

  it("refuses explicitly when even the extracted audio is over the limit, rather than truncating it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const { extractAudio, cleanup } = await fakeExtraction(OPENAI_MAX_UPLOAD_BYTES + 1);
    const { fetchImpl } = okFetch();

    await expect(
      new OpenAiTranscribeProvider({ fetchImpl, extractAudio }).transcribe({ mediaPath: bigMediaPath })
    ).rejects.toBeInstanceOf(TranscriptMediaTooLargeError);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it("cleans the extracted audio up even when the request fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const { extractAudio, cleanup } = await fakeExtraction(1024);
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      new OpenAiTranscribeProvider({ fetchImpl, extractAudio }).transcribe({ mediaPath: bigMediaPath })
    ).rejects.toBeInstanceOf(TranscriptHttpError);

    expect(cleanup).toHaveBeenCalled();
  });

  it("leaves a file that already fits completely untouched — no ffmpeg, no re-encoding", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key-for-test-only");
    const smallPath = path.join(dir, "court.mp4");
    await writeFile(smallPath, "petit fichier");
    const extractAudio = vi.fn();
    const { fetchImpl, captured } = okFetch();

    await new OpenAiTranscribeProvider({ fetchImpl, extractAudio }).transcribe({ mediaPath: smallPath });

    expect(extractAudio).not.toHaveBeenCalled();
    expect(((captured()?.body as FormData).get("file") as File).name).toBe("court.mp4");
  });
});
