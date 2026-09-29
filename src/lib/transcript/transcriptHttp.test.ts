import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertLocalFileExists,
  assertOkResponse,
  clamp01,
  fetchWithTimeout,
  LocalMediaFileNotFoundError,
  parseJsonResponse,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
} from "./transcriptHttp";

describe("assertLocalFileExists", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-transcript-http-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves silently for a real file", async () => {
    const filePath = path.join(dir, "clip.mp4");
    await writeFile(filePath, "fake bytes");
    await expect(assertLocalFileExists(filePath)).resolves.toBeUndefined();
  });

  it("throws LocalMediaFileNotFoundError for a nonexistent path", async () => {
    await expect(assertLocalFileExists(path.join(dir, "missing.mp4"))).rejects.toBeInstanceOf(
      LocalMediaFileNotFoundError
    );
  });

  it("throws LocalMediaFileNotFoundError for a directory instead of a file", async () => {
    await expect(assertLocalFileExists(dir)).rejects.toBeInstanceOf(LocalMediaFileNotFoundError);
  });
});

describe("fetchWithTimeout", () => {
  it("resolves normally when the fetch resolves before the timeout", async () => {
    const fakeResponse = new Response("ok");
    const fetchImpl = async () => fakeResponse;
    const res = await fetchWithTimeout(fetchImpl, "test-provider", "https://example.invalid", {}, 1000);
    expect(res).toBe(fakeResponse);
  });

  it("throws TranscriptTimeoutError when the request is aborted", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    await expect(
      fetchWithTimeout(fetchImpl, "test-provider", "https://example.invalid", {}, 10)
    ).rejects.toBeInstanceOf(TranscriptTimeoutError);
  });

  it("propagates non-abort network errors unchanged", async () => {
    const fetchImpl = (async () => {
      throw new Error("DNS resolution failed");
    }) as typeof fetch;

    await expect(
      fetchWithTimeout(fetchImpl, "test-provider", "https://example.invalid", {}, 1000)
    ).rejects.toThrow("DNS resolution failed");
  });

  it("never actually reaches the network (the injected fetchImpl is always a stub)", async () => {
    const originalFetch = globalThis.fetch;
    let realFetchCalled = false;
    globalThis.fetch = () => {
      realFetchCalled = true;
      throw new Error("should not be called");
    };
    try {
      const fetchImpl = async () => new Response("ok");
      await fetchWithTimeout(fetchImpl, "test-provider", "https://example.invalid", {}, 1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(realFetchCalled).toBe(false);
  });
});

describe("assertOkResponse", () => {
  it("resolves for a 2xx response", async () => {
    await expect(assertOkResponse(new Response("ok", { status: 200 }), "p")).resolves.toBeUndefined();
  });

  it("throws TranscriptHttpError with the status for a non-2xx response", async () => {
    const res = new Response("bad request body", { status: 400, statusText: "Bad Request" });
    await expect(assertOkResponse(res, "p")).rejects.toMatchObject({
      name: "TranscriptHttpError",
      status: 400,
    });
  });
});

describe("parseJsonResponse", () => {
  it("parses a valid JSON body", async () => {
    const res = new Response(JSON.stringify({ ok: true }));
    await expect(parseJsonResponse(res, "p")).resolves.toEqual({ ok: true });
  });

  it("throws TranscriptInvalidPayloadError for a non-JSON body", async () => {
    const res = new Response("not json");
    await expect(parseJsonResponse(res, "p")).rejects.toBeInstanceOf(TranscriptInvalidPayloadError);
  });
});

describe("clamp01", () => {
  it("clamps values into [0, 1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});
