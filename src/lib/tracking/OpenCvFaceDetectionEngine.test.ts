import { describe, expect, it } from "vitest";
import {
  OpenCvEngineExecutionError,
  OpenCvEngineInvalidOutputError,
  parseOpenCvOutput,
  parseOpenCvSceneOutput,
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

describe("parseOpenCvOutput — identité et activité labiale", () => {
  function payloadWith(extra: Record<string, unknown>) {
    return {
      source: { width: 1280, height: 720, duration_sec: 4.5 },
      detections: [
        { tSec: 0.5, x: 0.4, y: 0.3, width: 0.2, height: 0.3, confidence: 0.8, kind: "face", ...extra },
      ],
    };
  }

  it("lit l'identité et l'activité quand le script les fournit", () => {
    const detections = parseOpenCvOutput(JSON.stringify(payloadWith({ track_id: "t2", activity: 0.0413 })));
    expect(detections[0].trackId).toBe("t2");
    expect(detections[0].activity).toBe(0.0413);
  });

  it("accepte une détection sans identité ni activité : un moteur plus ancien reste utilisable", () => {
    const detections = parseOpenCvOutput(JSON.stringify(payloadWith({})));
    expect(detections[0].trackId).toBeUndefined();
    expect("activity" in detections[0]).toBe(false);
  });

  it("ne transforme jamais une activité absente en zéro", () => {
    // "Not measured" and "measured as still" lead to opposite conclusions
    // about who is speaking; conflating them would let a silent engine
    // decide.
    const detections = parseOpenCvOutput(JSON.stringify(payloadWith({})));
    expect(detections[0].activity).toBeUndefined();
  });

  it("refuse une activité hors de [0, 1]", () => {
    expect(() => parseOpenCvOutput(JSON.stringify(payloadWith({ activity: 1.5 })))).toThrow(
      OpenCvEngineInvalidOutputError
    );
    expect(() => parseOpenCvOutput(JSON.stringify(payloadWith({ activity: -0.1 })))).toThrow(
      OpenCvEngineInvalidOutputError
    );
  });

  it("refuse une identité vide ou d'un autre type", () => {
    expect(() => parseOpenCvOutput(JSON.stringify(payloadWith({ track_id: "" })))).toThrow(
      OpenCvEngineInvalidOutputError
    );
    expect(() => parseOpenCvOutput(JSON.stringify(payloadWith({ track_id: 3 })))).toThrow(
      OpenCvEngineInvalidOutputError
    );
  });
});

describe("parseOpenCvSceneOutput — coupes de caméra", () => {
  it("returns the camera cuts alongside the detections", () => {
    const result = parseOpenCvSceneOutput(JSON.stringify({ ...validPayload(), cuts: [1.2, 3.4] }));
    expect(result.cuts).toEqual([1.2, 3.4]);
    expect(result.detections).toHaveLength(2);
  });

  it("reads a script from before cuts existed as a video without cuts", () => {
    expect(parseOpenCvSceneOutput(JSON.stringify(validPayload())).cuts).toEqual([]);
  });

  it("rejects cuts that are not positive seconds", () => {
    expect(() => parseOpenCvSceneOutput(JSON.stringify({ ...validPayload(), cuts: [-1] }))).toThrow(
      OpenCvEngineInvalidOutputError
    );
    expect(() => parseOpenCvSceneOutput(JSON.stringify({ ...validPayload(), cuts: "1.2" }))).toThrow(
      OpenCvEngineInvalidOutputError
    );
  });
});
