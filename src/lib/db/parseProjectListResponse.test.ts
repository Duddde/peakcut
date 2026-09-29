import { describe, expect, it } from "vitest";
import { ProjectListResponseParseError, parseProjectListResponse } from "./parseProjectListResponse";

function valid() {
  return {
    ok: true,
    projects: [{ id: "p1", title: "Projet 1", status: "draft", updatedAt: "2026-01-01T00:00:00.000Z" }],
  };
}

describe("parseProjectListResponse", () => {
  it("parses a well-formed project list", () => {
    const result = parseProjectListResponse(valid());
    expect(result).toEqual([{ id: "p1", title: "Projet 1", status: "draft", updatedAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("returns an empty array for an empty list", () => {
    expect(parseProjectListResponse({ ok: true, projects: [] })).toEqual([]);
  });

  it("throws when ok is not true", () => {
    expect(() => parseProjectListResponse({ ok: false })).toThrow(ProjectListResponseParseError);
  });

  it("throws when projects is not an array", () => {
    expect(() => parseProjectListResponse({ ok: true, projects: "nope" })).toThrow(
      ProjectListResponseParseError
    );
  });

  it("throws when a summary entry is missing a required field", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.projects[0].status;
    expect(() => parseProjectListResponse(payload)).toThrow(ProjectListResponseParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseProjectListResponse(null)).toThrow(ProjectListResponseParseError);
  });
});
