import { describe, expect, it } from "vitest";
import { validateYoutubeUrl } from "./validateYoutubeUrl";

describe("validateYoutubeUrl", () => {
  it("accepts a standard watch URL", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videoId).toBe("dQw4w9WgXcQ");
      expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  it("accepts a bare youtube.com host without www", () => {
    const result = validateYoutubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
  });

  it("accepts the mobile host", () => {
    const result = validateYoutubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
  });

  it("accepts a youtu.be short link", () => {
    const result = validateYoutubeUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.videoId).toBe("dQw4w9WgXcQ");
  });

  it("accepts a youtu.be link with a timestamp query param", () => {
    const result = validateYoutubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42");
    expect(result.ok).toBe(true);
  });

  it("accepts a /shorts/ URL", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.videoId).toBe("dQw4w9WgXcQ");
  });

  it("accepts an /embed/ URL", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
  });

  it("keeps extra query params out of the normalized URL", () => {
    const result = validateYoutubeUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz&index=3&t=10s"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  it("trims surrounding whitespace", () => {
    const result = validateYoutubeUrl("  https://youtu.be/dQw4w9WgXcQ  ");
    expect(result.ok).toBe(true);
  });

  it("rejects a non-URL string", () => {
    const result = validateYoutubeUrl("not a url");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = validateYoutubeUrl("");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-YouTube domain", () => {
    const result = validateYoutubeUrl("https://vimeo.com/123456789");
    expect(result.ok).toBe(false);
  });

  it("rejects a domain that merely contains youtube.com as a substring", () => {
    const result = validateYoutubeUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(false);
  });

  it("rejects a watch URL with no video id", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/watch");
    expect(result.ok).toBe(false);
  });

  it("rejects the bare homepage", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/");
    expect(result.ok).toBe(false);
  });

  it("rejects playlist-only URLs", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/playlist?list=PLxyz123");
    expect(result.ok).toBe(false);
  });

  it("rejects channel URLs", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/channel/UCabcdefghijklmnop");
    expect(result.ok).toBe(false);
  });

  it("rejects @handle URLs without a video", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/@somecreator");
    expect(result.ok).toBe(false);
  });

  it("rejects studio.youtube.com URLs", () => {
    const result = validateYoutubeUrl("https://studio.youtube.com/video/dQw4w9WgXcQ/edit");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed video id (wrong length)", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/watch?v=short");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed video id (invalid characters)", () => {
    const result = validateYoutubeUrl("https://www.youtube.com/watch?v=<script>ab</script>");
    expect(result.ok).toBe(false);
  });

  it("rejects non-http(s) protocols", () => {
    const result = validateYoutubeUrl("ftp://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(false);
  });

  it("rejects URLs carrying userinfo credentials", () => {
    const result = validateYoutubeUrl("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(false);
  });

  it("never triggers a network fetch (pure structural validation)", () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      validateYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      validateYoutubeUrl("https://vimeo.com/123");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});
