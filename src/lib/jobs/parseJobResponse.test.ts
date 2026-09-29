import { describe, expect, it } from "vitest";
import { parseJobResponse, JobResponseParseError } from "./parseJobResponse";

function validJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    projectId: "proj-1",
    kind: "render",
    status: "running",
    progress: 42,
    attempts: 1,
    maxAttempts: 3,
    payload: { segmentId: "seg-1" },
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: null,
    idempotencyKey: null,
    ...overrides,
  };
}

describe("parseJobResponse", () => {
  it("parses a valid job envelope", () => {
    const parsed = parseJobResponse({ ok: true, job: validJob() });
    expect(parsed.id).toBe("job-1");
    expect(parsed.kind).toBe("render");
    expect(parsed.status).toBe("running");
    expect(parsed.progress).toBe(42);
    expect(parsed.payload).toEqual({ segmentId: "seg-1" });
  });

  it("rejects an unknown kind", () => {
    expect(() => parseJobResponse({ job: validJob({ kind: "unknown-kind" }) })).toThrow(JobResponseParseError);
  });

  it("rejects an unknown status", () => {
    expect(() => parseJobResponse({ job: validJob({ status: "unknown-status" }) })).toThrow(JobResponseParseError);
  });

  it("rejects a non-object envelope", () => {
    expect(() => parseJobResponse(null)).toThrow(JobResponseParseError);
  });

  it("rejects a missing job", () => {
    expect(() => parseJobResponse({ ok: true })).toThrow(JobResponseParseError);
  });
});
