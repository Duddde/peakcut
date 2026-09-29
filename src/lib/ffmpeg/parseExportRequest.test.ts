import { describe, expect, it } from "vitest";
import { ExportRequestParseError, parseExportRequestBody } from "./parseExportRequest";

function valid() {
  return {
    sourcePath: "abc123.mp4",
    startSec: 1,
    endSec: 4,
    words: [{ text: "Bonjour", start_sec: 1.2, end_sec: 1.5, speaker: "A", confidence: 0.9 }],
    crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    workflow: {
      phase: "export_authorized",
      publicationPolicy: "publication_never_implicit",
      rights: { confirmed: true, confirmedAt: "2026-01-01T00:00:00.000Z", confirmedBy: "someone" },
    },
  };
}

describe("parseExportRequestBody", () => {
  it("parses a well-formed request", () => {
    const result = parseExportRequestBody(valid());
    expect(result.sourcePath).toBe("abc123.mp4");
    expect(result.startSec).toBe(1);
    expect(result.endSec).toBe(4);
    expect(result.words).toHaveLength(1);
    expect(result.words[0].startSec).toBe(1.2);
    expect(result.crop).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(result.workflow.phase).toBe("export_authorized");
  });

  it("accepts a request without crop (optional)", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.crop;
    const result = parseExportRequestBody(payload);
    expect(result.crop).toBeUndefined();
  });

  it("throws when sourcePath is missing or empty", () => {
    expect(() => parseExportRequestBody({ ...valid(), sourcePath: "" })).toThrow(
      ExportRequestParseError
    );
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.sourcePath;
    expect(() => parseExportRequestBody(payload)).toThrow(ExportRequestParseError);
  });

  it("throws when endSec is not greater than startSec", () => {
    expect(() => parseExportRequestBody({ ...valid(), startSec: 5, endSec: 5 })).toThrow(
      ExportRequestParseError
    );
    expect(() => parseExportRequestBody({ ...valid(), startSec: 5, endSec: 2 })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when words is not an array", () => {
    expect(() => parseExportRequestBody({ ...valid(), words: "nope" })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when workflow is missing or invalid", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.workflow;
    expect(() => parseExportRequestBody(payload)).toThrow(ExportRequestParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseExportRequestBody(null)).toThrow(ExportRequestParseError);
  });

  it("rejects a sourcePath containing path traversal segments", () => {
    expect(() => parseExportRequestBody({ ...valid(), sourcePath: "../../etc/passwd" })).toThrow(
      ExportRequestParseError
    );
  });

  it("accepts a request without renderPlan (optional)", () => {
    const result = parseExportRequestBody(valid());
    expect(result.renderPlan).toBeUndefined();
  });

  it("parses a well-formed renderPlan", () => {
    const result = parseExportRequestBody({ ...valid(), renderPlan: validRenderPlan() });
    expect(result.renderPlan?.templateId).toBe("hook-emphasis");
    expect(result.renderPlan?.zoomKeyframes).toHaveLength(2);
    expect(result.renderPlan?.subtitleStyle.primaryColorHex).toBe("#FFD24D");
    expect(result.renderPlan?.safeZones).toHaveLength(1);
  });

  it("does not reject a structurally-valid but out-of-bounds renderPlan (bounds checking happens at export time)", () => {
    const plan = validRenderPlan();
    plan.zoomKeyframes = [{ tSec: 0, scale: 50 }];
    const result = parseExportRequestBody({ ...valid(), renderPlan: plan });
    expect(result.renderPlan?.zoomKeyframes[0].scale).toBe(50);
  });

  it("throws when renderPlan.templateId is not a recognized template", () => {
    const plan = validRenderPlan();
    plan.templateId = "not-a-template";
    expect(() => parseExportRequestBody({ ...valid(), renderPlan: plan })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when renderPlan.subtitleStyle is missing", () => {
    const plan = validRenderPlan();
    // @ts-expect-error intentionally malformed
    delete plan.subtitleStyle;
    expect(() => parseExportRequestBody({ ...valid(), renderPlan: plan })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when renderPlan.zoomKeyframes is not an array", () => {
    const plan = validRenderPlan();
    // @ts-expect-error intentionally malformed
    plan.zoomKeyframes = "nope";
    expect(() => parseExportRequestBody({ ...valid(), renderPlan: plan })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when renderPlan.cuts is not an array", () => {
    const plan = validRenderPlan();
    // @ts-expect-error intentionally malformed
    plan.cuts = "nope";
    expect(() => parseExportRequestBody({ ...valid(), renderPlan: plan })).toThrow(
      ExportRequestParseError
    );
  });

  it("throws when renderPlan.limitations is missing", () => {
    const plan = validRenderPlan();
    // @ts-expect-error intentionally malformed
    delete plan.limitations;
    expect(() => parseExportRequestBody({ ...valid(), renderPlan: plan })).toThrow(
      ExportRequestParseError
    );
  });
});

function validRenderPlan() {
  return {
    templateId: "hook-emphasis",
    intensity: 0.7,
    cuts: [{ startSec: 0, endSec: 4 }],
    zoomKeyframes: [
      { tSec: 0, scale: 1 },
      { tSec: 4, scale: 1.15 },
    ],
    subtitleStyle: {
      fontSizeScale: 1.25,
      primaryColorHex: "#FFD24D",
      marginVerticalScale: 1.1,
      emphasizeKeywords: true,
    },
    safeZones: [
      {
        id: "seg-1-safezone-subtitles",
        purpose: "subtitle-area",
        label: "Zone sous-titres",
        rect: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
      },
    ],
    audioDucking: { enabled: false, duckDb: 0, attackSec: 0.02, releaseSec: 0.05 },
    limitations: ["Le zoom animé n'est pas encore appliqué image par image."],
  };
}
