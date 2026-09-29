import { describe, expect, it } from "vitest";
import { buildDemoProject } from "./buildDemoProject";

describe("buildDemoProject", () => {
  it("builds a project with a full data model: source, transcript, segments, timeline, workflow", async () => {
    const project = await buildDemoProject();

    expect(project.source.type).toBe("local-upload");
    expect(project.source.originTimestamp).toBeTruthy();
    expect(project.source.confidence).toBeGreaterThan(0);
    expect(project.transcript?.words.length).toBeGreaterThan(0);
    expect(project.segments.length).toBeGreaterThanOrEqual(2);
    expect(project.timeline?.clips.length).toBeGreaterThan(0);
    expect(project.workflow.phase).toBe("analysis_preview");
    expect(project.workflow.publicationPolicy).toBe("publication_never_implicit");
    expect(project.workflow.rights.confirmed).toBe(false);
  });

  it("gives every segment an explainable score, safe zones and crop variants", async () => {
    const project = await buildDemoProject();
    for (const segment of project.segments) {
      expect(segment.score).not.toBeNull();
      expect(segment.score!.explanation.breakdown).toBeDefined();
      expect(segment.safeZones.length).toBeGreaterThan(0);
      expect(segment.variants.length).toBeGreaterThan(0);
      expect(segment.words.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic across calls", async () => {
    const a = await buildDemoProject();
    const b = await buildDemoProject();
    expect(a.segments.map((s) => s.score?.value)).toEqual(b.segments.map((s) => s.score?.value));
    expect(a.transcript).toEqual(b.transcript);
  });
});
