import { describe, expect, it } from "vitest";
import { IngestResponseParseError, parseIngestResponse } from "./parseIngestResponse";

function validPayload() {
  return {
    ok: true,
    source: {
      id: "src-1",
      type: "local-upload",
      title: "clip.mp4",
      localFilePath: "/data/uploads/abc.mp4",
      durationSec: 12.5,
      originTimestamp: "2026-01-01T00:00:00.000Z",
      confidence: 1,
    },
    workflow: {
      phase: "analysis_preview",
      publicationPolicy: "publication_never_implicit",
      rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
    },
  };
}

describe("parseIngestResponse", () => {
  it("parses a well-formed successful response", () => {
    const result = parseIngestResponse(validPayload());
    expect(result.source.id).toBe("src-1");
    expect(result.source.type).toBe("local-upload");
    expect(result.source.durationSec).toBe(12.5);
    expect(result.workflow.phase).toBe("analysis_preview");
    expect(result.workflow.rights.confirmed).toBe(false);
  });

  it("throws when ok is not true", () => {
    expect(() => parseIngestResponse({ ok: false, error: "x" })).toThrow(IngestResponseParseError);
  });

  it("throws when source is missing", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed
    delete payload.source;
    expect(() => parseIngestResponse(payload)).toThrow(IngestResponseParseError);
  });

  it("throws when source.type is not local-upload or youtube", () => {
    const payload = validPayload();
    payload.source.type = "ftp";
    expect(() => parseIngestResponse(payload)).toThrow(IngestResponseParseError);
  });

  it("throws when workflow.phase is invalid", () => {
    const payload = validPayload();
    payload.workflow.phase = "published";
    expect(() => parseIngestResponse(payload)).toThrow(IngestResponseParseError);
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseIngestResponse(undefined)).toThrow(IngestResponseParseError);
  });
});
