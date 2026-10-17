import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiImageProvider } from "./OpenAiImageProvider";
import {
  ImageProviderHttpError,
  ImageProviderInvalidPayloadError,
  ImageProviderNotConfiguredError,
  ImageProviderTimeoutError,
} from "./ImageProvider";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenAiImageProvider", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "cle-de-test";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("fails without an API key, and sends nothing", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchImpl = vi.fn();
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.generate({ prompt: "un graphique", aspect: "portrait" })).rejects.toBeInstanceOf(
      ImageProviderNotConfiguredError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the decoded image bytes", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      okResponse({ data: [{ b64_json: PNG.toString("base64") }] })
    );
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const image = await provider.generate({ prompt: "un graphique qui monte", aspect: "portrait" });
    expect(image.data).toEqual(PNG);
    expect(image.providerId).toBe("openai-gpt-image-1");
    expect(image.prompt).toBe("un graphique qui monte");
  });

  it("asks for a vertical image for a short, and a square one when asked", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      okResponse({ data: [{ b64_json: PNG.toString("base64") }] })
    );
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.generate({ prompt: "un graphique", aspect: "portrait" });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).size).toBe("1024x1536");

    await provider.generate({ prompt: "un graphique", aspect: "square" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]!.body)).size).toBe("1024x1024");
  });

  it("sends the key in the Authorization header and nowhere else", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      okResponse({ data: [{ b64_json: PNG.toString("base64") }] })
    );
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.generate({ prompt: "un graphique", aspect: "portrait" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer cle-de-test");
    expect(String(init!.body)).not.toContain("cle-de-test");
  });

  it("surfaces an HTTP error with its status rather than inventing an image", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota depasse", { status: 429, statusText: "Too Many Requests" }));
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.generate({ prompt: "un graphique", aspect: "portrait" })).rejects.toBeInstanceOf(
      ImageProviderHttpError
    );
  });

  it("refuses a response with no image in it", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ data: [] }));
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.generate({ prompt: "un graphique", aspect: "portrait" })).rejects.toBeInstanceOf(
      ImageProviderInvalidPayloadError
    );
  });

  it("refuses a response that is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oups</html>", { status: 200 }));
    const provider = new OpenAiImageProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.generate({ prompt: "un graphique", aspect: "portrait" })).rejects.toBeInstanceOf(
      ImageProviderInvalidPayloadError
    );
  });

  it("times out instead of hanging on a provider that never answers", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const provider = new OpenAiImageProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await expect(provider.generate({ prompt: "un graphique", aspect: "portrait" })).rejects.toBeInstanceOf(
      ImageProviderTimeoutError
    );
  });
});
