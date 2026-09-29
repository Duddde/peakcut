import { describe, expect, it } from "vitest";
import {
  OpenCvEngineExecutionError,
  OpenCvEngineInvalidOutputError,
  parseOpenCvOutput,
} from "./OpenCvFaceDetectionEngine";

function validPayload() {
  return {
    source: { width: 1280, height: 720, duration_sec: 4.5 },
    detections: [
      { tSec: 0.5, x: 0.4, y: 0.3, width: 0.2, height: 0.3, confidence: 0.8, kind: "face" },
      { tSec: 1.0, x: 0.41, y: 0.31, width: 0.2, height: 0.3, confidence: 0.75, kind: "face" },
    ],
  };
}

describe("parseOpenCvOutput", () => {
  it("parses a well-formed success payload into DetectedBoundingBox[]", () => {
    const result = parseOpenCvOutput(JSON.stringify(validPayload()));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tSec: 0.5, x: 0.4, y: 0.3, width: 0.2, height: 0.3, score: 0.8 });
  });

  it("accepts an empty detections array (no faces found is a valid outcome)", () => {
    const payload = validPayload();
    payload.detections = [];
    expect(parseOpenCvOutput(JSON.stringify(payload))).toEqual([]);
  });

  it("throws OpenCvEngineExecutionError for the documented {error: ...} shape", () => {
    expect(() => parseOpenCvOutput(JSON.stringify({ error: "cv2 not installed" }))).toThrow(
      OpenCvEngineExecutionError
    );
  });

  it("throws OpenCvEngineInvalidOutputError for non-JSON stdout", () => {
    expect(() => parseOpenCvOutput("not json at all")).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("throws OpenCvEngineInvalidOutputError when source is missing", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed
    delete payload.source;
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("throws OpenCvEngineInvalidOutputError when detections is not an array", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed
    payload.detections = "nope";
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("rejects a confidence outside [0, 1]", () => {
    const payload = validPayload();
    payload.detections[0].confidence = 5;
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("rejects a detection missing a required field", () => {
    const payload = validPayload();
    // @ts-expect-error intentionally malformed
    delete payload.detections[0].width;
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it('rejects a detection whose kind is not "face"', () => {
    const payload = validPayload();
    payload.detections[0].kind = "car";
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("rejects a negative tSec", () => {
    const payload = validPayload();
    payload.detections[0].tSec = -1;
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });

  it("rejects zero or negative width/height", () => {
    const payload = validPayload();
    payload.detections[0].width = 0;
    expect(() => parseOpenCvOutput(JSON.stringify(payload))).toThrow(OpenCvEngineInvalidOutputError);
  });
});
