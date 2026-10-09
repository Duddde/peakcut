import { describe, expect, it } from "vitest";
import { DEFAULT_CALLBACK_URL, relativeUrlOf, safeCallbackUrl } from "./safeCallbackUrl";

describe("safeCallbackUrl", () => {
  it("keeps same-origin relative paths, including query and hash", () => {
    expect(safeCallbackUrl("/projects/abc?x=1")).toBe("/projects/abc?x=1");
    expect(safeCallbackUrl("/#studio")).toBe("/#studio");
  });

  it("falls back for anything that could leave the site", () => {
    for (const raw of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "projects",
      "/\tevil",
      "",
    ]) {
      expect(safeCallbackUrl(raw)).toBe(DEFAULT_CALLBACK_URL);
    }
  });

  it("falls back for non-string values and honours a custom fallback", () => {
    expect(safeCallbackUrl(undefined)).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl(["/a", "/b"])).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl("https://evil.example", "/")).toBe("/");
  });
});

describe("relativeUrlOf", () => {
  it("drops the origin and keeps path, query and hash", () => {
    expect(relativeUrlOf({ pathname: "/projects/p1", search: "?tab=2", hash: "#export" })).toBe(
      "/projects/p1?tab=2#export"
    );
  });
});
