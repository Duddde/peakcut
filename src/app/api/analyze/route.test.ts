// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function postRequest(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/analyze", () => {
  it("returns 200 with ranked segments using a snake_case contract", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.segments)).toBe(true);
    expect(json.segments.length).toBeGreaterThanOrEqual(2);

    const first = json.segments[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("rank");
    expect(first).toHaveProperty("start_sec");
    expect(first).toHaveProperty("end_sec");
    expect(first).toHaveProperty("score");
    expect(first).toHaveProperty("confidence");
    expect(first).toHaveProperty("score_breakdown");
    expect(first.score_breakdown).toHaveProperty("lexical_density");
    expect(first.score_breakdown).toHaveProperty("speaker_change");
    expect(first).toHaveProperty("categories");
    expect(first).toHaveProperty("reasons");
    expect(first).toHaveProperty("penalty_reasons");

    expect(Array.isArray(first.words)).toBe(true);
    expect(first.words.length).toBeGreaterThan(0);
    expect(first.words[0]).toHaveProperty("text");
    expect(first.words[0]).toHaveProperty("start_sec");
    expect(first.words[0]).toHaveProperty("end_sec");
    expect(first.words[0]).toHaveProperty("confidence");

    expect(Array.isArray(first.safe_zones)).toBe(true);
    expect(first.safe_zones.length).toBeGreaterThan(0);
    expect(first.safe_zones[0]).toHaveProperty("rect");

    expect(Array.isArray(first.variants)).toBe(true);
    expect(first.variants.length).toBeGreaterThan(0);
    expect(first.variants[0]).toHaveProperty("aspect_ratio");
    expect(first.variants[0]).toHaveProperty("crop");
  });

  it("ranks segments in descending score order with 1-based ranks", async () => {
    const res = await POST(postRequest());
    const json = await res.json();
    for (let i = 1; i < json.segments.length; i++) {
      expect(json.segments[i - 1].score).toBeGreaterThanOrEqual(json.segments[i].score);
    }
    expect(json.segments.map((s: { rank: number }) => s.rank)).toEqual(
      json.segments.map((_: unknown, i: number) => i + 1)
    );
  });

  it("never mentions watch time or virality anywhere in the response", async () => {
    const res = await POST(postRequest());
    const text = JSON.stringify(await res.json()).toLowerCase();
    expect(text).not.toContain("watch time");
    expect(text).not.toContain("viral");
  });

  it("returns 400 for an invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("never performs network I/O (fully deterministic, offline)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called");
    };
    try {
      await POST(postRequest());
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  it("is deterministic across repeated calls", async () => {
    const a = await (await POST(postRequest())).json();
    const b = await (await POST(postRequest())).json();
    expect(a).toEqual(b);
  });
});
