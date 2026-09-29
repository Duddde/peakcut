// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTranscribeHandler } from "./route";
import type { TranscriptProvider, TranscriptRequest } from "@/lib/transcript/TranscriptProvider";
import { TranscriptProviderNotConfiguredError } from "@/lib/transcript/TranscriptProvider";
import {
  LocalMediaFileNotFoundError,
  TranscriptHttpError,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
} from "@/lib/transcript/transcriptHttp";
import type { Transcript } from "@/lib/domain/types";

function fakeProvider(id: string, behavior: (req: TranscriptRequest) => Promise<Transcript>): TranscriptProvider {
  return { id, displayName: `Fake ${id}`, transcribe: behavior };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/transcribe", () => {
  let workDir: string;
  let uploadsDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "peakcut-transcribe-route-"));
    uploadsDir = path.join(workDir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    sourcePath = path.join(uploadsDir, "clip.mp4");
    await writeFile(sourcePath, "fake media bytes");
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function handler(providers?: TranscriptProvider[]) {
    return createTranscribeHandler({ uploadsBaseDir: uploadsDir, providers });
  }

  it("returns 400 for invalid JSON", async () => {
    const POST = handler();
    const req = new NextRequest("http://localhost/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when providerId or sourcePath is missing", async () => {
    const POST = handler();
    expect((await POST(postRequest({ sourcePath }))).status).toBe(400);
    expect((await POST(postRequest({ providerId: "mock-deterministic" }))).status).toBe(400);
  });

  it("returns 400 for a sourcePath containing a path traversal segment", async () => {
    const POST = handler();
    const res = await POST(
      postRequest({ providerId: "mock-deterministic", sourcePath: "../../etc/passwd" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown providerId", async () => {
    const POST = handler();
    const res = await POST(postRequest({ providerId: "does-not-exist", sourcePath }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 403 when sourcePath resolves outside the configured uploads directory", async () => {
    const POST = handler();
    const outside = path.join(workDir, "outside.mp4");
    await writeFile(outside, "x");
    const res = await POST(postRequest({ providerId: "mock-deterministic", sourcePath: outside }));
    expect(res.status).toBe(403);
  });

  it("returns 404 when sourcePath points to a nonexistent file inside the uploads dir", async () => {
    const POST = handler();
    const missing = path.join(uploadsDir, "missing.mp4");
    const res = await POST(postRequest({ providerId: "mock-deterministic", sourcePath: missing }));
    expect(res.status).toBe(404);
  });

  it("succeeds end-to-end with the real deterministic mock provider from the registry", async () => {
    const POST = handler(); // default registry, no injection needed for the mock
    const res = await POST(postRequest({ providerId: "mock-deterministic", sourcePath }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.provider_id).toBe("mock-deterministic");
    expect(json.transcript.words.length).toBeGreaterThan(0);
    expect(json.transcript.words[0]).toHaveProperty("start_sec");
    expect(json.transcript.words[0]).toHaveProperty("end_sec");
    expect(json.transcript.words[0]).toHaveProperty("confidence");
  });

  it("returns 503 when a real provider is registered but not configured (no fallback to the mock)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const POST = handler(); // real registry, real OpenAiTranscribeProvider, key intentionally unset
    const res = await POST(
      postRequest({ providerId: "openai-gpt-4o-transcribe-diarize", sourcePath })
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("maps TranscriptTimeoutError from a provider to 504", async () => {
    const providers = [
      fakeProvider("fake-timeout", async () => {
        throw new TranscriptTimeoutError("fake-timeout", 1000);
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-timeout", sourcePath }));
    expect(res.status).toBe(504);
  });

  it("maps TranscriptHttpError from a provider to 502", async () => {
    const providers = [
      fakeProvider("fake-http-error", async () => {
        throw new TranscriptHttpError("fake-http-error", 401, "Unauthorized", "invalid key");
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-http-error", sourcePath }));
    expect(res.status).toBe(502);
  });

  it("maps TranscriptInvalidPayloadError from a provider to 502", async () => {
    const providers = [
      fakeProvider("fake-bad-payload", async () => {
        throw new TranscriptInvalidPayloadError("fake-bad-payload", "missing words");
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-bad-payload", sourcePath }));
    expect(res.status).toBe(502);
  });

  it("maps TranscriptProviderNotConfiguredError from an injected provider to 503", async () => {
    const providers = [
      fakeProvider("fake-unconfigured", async () => {
        throw new TranscriptProviderNotConfiguredError("fake-unconfigured", "FAKE_API_KEY");
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-unconfigured", sourcePath }));
    expect(res.status).toBe(503);
  });

  it("maps LocalMediaFileNotFoundError from a provider to 404", async () => {
    const providers = [
      fakeProvider("fake-missing-file", async () => {
        throw new LocalMediaFileNotFoundError("/some/path.mp4");
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-missing-file", sourcePath }));
    expect(res.status).toBe(404);
  });

  it("maps an unexpected error to 500 without leaking internals", async () => {
    const providers = [
      fakeProvider("fake-crash", async () => {
        throw new Error("some internal detail that should not leak verbatim");
      }),
    ];
    const POST = handler(providers);
    const res = await POST(postRequest({ providerId: "fake-crash", sourcePath }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).not.toContain("some internal detail");
  });

  it("never reveals the absolute uploads directory path in any response", async () => {
    const POST = handler();
    const res = await POST(postRequest({ providerId: "mock-deterministic", sourcePath }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(uploadsDir);
    expect(text).not.toContain(workDir);
  });
});
