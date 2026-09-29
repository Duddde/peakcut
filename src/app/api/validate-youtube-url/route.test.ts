import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/validate-youtube-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/validate-youtube-url", () => {
  it("returns 200 and the normalized URL for a valid public watch URL", async () => {
    const res = await POST(postRequest({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.videoId).toBe("dQw4w9WgXcQ");
    expect(json.normalizedUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("returns 422 with an explanation for an invalid URL", async () => {
    const res = await POST(postRequest({ url: "https://vimeo.com/123456" }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe("string");
  });

  it("returns 400 when the url field is missing", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/validate-youtube-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects a playlist-only URL with 422", async () => {
    const res = await POST(postRequest({ url: "https://www.youtube.com/playlist?list=PLxyz" }));
    expect(res.status).toBe(422);
  });

  it("never triggers outbound network I/O (no download, no publish)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      await POST(postRequest({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});
