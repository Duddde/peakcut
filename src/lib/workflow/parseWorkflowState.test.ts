import { describe, expect, it } from "vitest";
import { parseWorkflowState, WorkflowStateParseError } from "./parseWorkflowState";

function valid() {
  return {
    phase: "export_authorized",
    publicationPolicy: "publication_never_implicit",
    rights: { confirmed: true, confirmedAt: "2026-01-01T00:00:00.000Z", confirmedBy: "someone" },
  };
}

describe("parseWorkflowState", () => {
  it("parses a well-formed workflow", () => {
    const result = parseWorkflowState(valid());
    expect(result.phase).toBe("export_authorized");
    expect(result.rights.confirmed).toBe(true);
    expect(result.rights.confirmedBy).toBe("someone");
  });

  it("throws for an invalid phase", () => {
    expect(() => parseWorkflowState({ ...valid(), phase: "published" })).toThrow(
      WorkflowStateParseError
    );
  });

  it("throws when publicationPolicy is anything other than publication_never_implicit", () => {
    expect(() =>
      parseWorkflowState({ ...valid(), publicationPolicy: "publication_allowed" })
    ).toThrow(WorkflowStateParseError);
  });

  it("throws when rights is missing", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.rights;
    expect(() => parseWorkflowState(payload)).toThrow(WorkflowStateParseError);
  });

  it("throws when rights.confirmed is not a boolean", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    payload.rights.confirmed = "yes";
    expect(() => parseWorkflowState(payload)).toThrow(WorkflowStateParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseWorkflowState(null)).toThrow(WorkflowStateParseError);
  });

  it("defaults confirmedAt/confirmedBy to null when absent", () => {
    const result = parseWorkflowState({
      phase: "analysis_preview",
      publicationPolicy: "publication_never_implicit",
      rights: { confirmed: false },
    });
    expect(result.rights.confirmedAt).toBeNull();
    expect(result.rights.confirmedBy).toBeNull();
  });
});
