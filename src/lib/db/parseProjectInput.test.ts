import { describe, expect, it } from "vitest";
import {
  ProjectInputParseError,
  parseProjectResponse,
  parseProjectUpdateInput,
  parseSegmentInput,
  parseSourceInput,
} from "./parseProjectInput";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { Project } from "@/lib/domain/types";
import { COMMON_LIMITATIONS, buildRenderPlan } from "@/lib/effects/buildRenderPlan";

function baseProject(): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "p1",
    title: "Titre initial",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: "s1",
      type: "local-upload",
      title: "clip.mp4",
      durationSec: 10,
      originTimestamp: now,
      confidence: 1,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
}

function validSegment() {
  return {
    id: "seg-1",
    title: "Segment",
    startSec: 0,
    endSec: 2,
    words: [{ text: "Bonjour", startSec: 0, endSec: 0.4, speaker: "A", confidence: 0.9 }],
    score: {
      value: 70,
      confidence: 0.6,
      explanation: {
        breakdown: { hook: 0.5, lexicalDensity: 0.4, question: 0, emotion: 0.2, speakerChange: 0, duration: 0.8, penalties: 0 },
        reasons: ["raison"],
        penaltyReasons: [],
      },
    },
    safeZones: [
      { id: "sz1", purpose: "subtitle-area", label: "Zone", rect: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 } },
    ],
    variants: [{ id: "v1", label: "Vertical", aspectRatio: "9:16", crop: { x: 0.34, y: 0, width: 0.32, height: 1 } }],
  };
}

describe("parseSourceInput", () => {
  it("parses a well-formed source", () => {
    const source = parseSourceInput({
      id: "s1",
      type: "local-upload",
      title: "clip.mp4",
      durationSec: 10,
      originTimestamp: "2026-01-01T00:00:00.000Z",
      confidence: 1,
    });
    expect(source.title).toBe("clip.mp4");
  });

  it("throws for a missing required field", () => {
    expect(() => parseSourceInput({ id: "s1", type: "local-upload" })).toThrow(ProjectInputParseError);
  });

  it("throws for an invalid type", () => {
    expect(() =>
      parseSourceInput({
        id: "s1",
        type: "ftp",
        title: "x",
        durationSec: 1,
        originTimestamp: "now",
        confidence: 1,
      })
    ).toThrow(ProjectInputParseError);
  });
});

describe("parseSegmentInput", () => {
  it("parses a fully well-formed segment", () => {
    const segment = parseSegmentInput(validSegment());
    expect(segment.id).toBe("seg-1");
    expect(segment.words).toHaveLength(1);
    expect(segment.score?.value).toBe(70);
    expect(segment.safeZones).toHaveLength(1);
    expect(segment.variants).toHaveLength(1);
  });

  it("accepts a null score", () => {
    const segment = parseSegmentInput({ ...validSegment(), score: null });
    expect(segment.score).toBeNull();
  });

  it("throws when words is not an array", () => {
    expect(() => parseSegmentInput({ ...validSegment(), words: "nope" })).toThrow(ProjectInputParseError);
  });

  it("throws when a required numeric field is missing", () => {
    const s = validSegment();
    // @ts-expect-error intentionally malformed
    delete s.startSec;
    expect(() => parseSegmentInput(s)).toThrow(ProjectInputParseError);
  });

  it("throws when safeZones is missing", () => {
    const s = validSegment();
    // @ts-expect-error intentionally malformed
    delete s.safeZones;
    expect(() => parseSegmentInput(s)).toThrow(ProjectInputParseError);
  });
});

describe("parseProjectUpdateInput", () => {
  it("returns the existing project unchanged when the patch body is empty", () => {
    const existing = baseProject();
    const result = parseProjectUpdateInput({}, existing);
    expect(result).toEqual(existing);
  });

  it("overrides only the provided top-level fields", () => {
    const existing = baseProject();
    const result = parseProjectUpdateInput({ title: "Nouveau titre" }, existing);
    expect(result.title).toBe("Nouveau titre");
    expect(result.status).toBe(existing.status);
    expect(result.source).toEqual(existing.source);
  });

  it("replaces segments when provided", () => {
    const existing = baseProject();
    const result = parseProjectUpdateInput({ segments: [validSegment()] }, existing);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].id).toBe("seg-1");
  });

  it("throws for an invalid status value", () => {
    const existing = baseProject();
    expect(() => parseProjectUpdateInput({ status: "not-a-status" }, existing)).toThrow(
      ProjectInputParseError
    );
  });

  it("accepts a null transcript and null timeline explicitly", () => {
    const existing = { ...baseProject(), transcript: { language: "fr", providerId: "x", words: [] } };
    const result = parseProjectUpdateInput({ transcript: null, timeline: null }, existing);
    expect(result.transcript).toBeNull();
    expect(result.timeline).toBeNull();
  });

  it("validates workflow via the shared parser when provided", () => {
    const existing = baseProject();
    const result = parseProjectUpdateInput(
      {
        workflow: {
          phase: "export_authorized",
          publicationPolicy: "publication_never_implicit",
          rights: { confirmed: true, confirmedAt: "now", confirmedBy: "me" },
        },
      },
      existing
    );
    expect(result.workflow.phase).toBe("export_authorized");
  });

  it("throws for a non-object patch body", () => {
    expect(() => parseProjectUpdateInput("nope", baseProject())).toThrow(ProjectInputParseError);
  });
});

describe("parseProjectResponse", () => {
  it("parses a full, well-formed project", () => {
    const project = baseProject();
    const result = parseProjectResponse(project);
    expect(result).toEqual(project);
  });

  it("parses a project with segments and a non-null transcript/timeline", () => {
    const project = {
      ...baseProject(),
      segments: [validSegment()],
      transcript: { language: "fr", providerId: "mock-deterministic", words: [] },
      timeline: { clips: [], totalDurationSec: 5 },
    };
    const result = parseProjectResponse(project);
    expect(result.segments).toHaveLength(1);
    expect(result.transcript?.language).toBe("fr");
    expect(result.timeline?.totalDurationSec).toBe(5);
  });

  it("throws for an invalid status", () => {
    const project = { ...baseProject(), status: "not-a-status" };
    expect(() => parseProjectResponse(project)).toThrow(ProjectInputParseError);
  });

  it("throws when segments is missing", () => {
    const project = baseProject() as unknown as Record<string, unknown>;
    delete project.segments;
    expect(() => parseProjectResponse(project)).toThrow(ProjectInputParseError);
  });

  it("throws when workflow is missing", () => {
    const project = baseProject() as unknown as Record<string, unknown>;
    delete project.workflow;
    expect(() => parseProjectResponse(project)).toThrow(ProjectInputParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseProjectResponse(null)).toThrow(ProjectInputParseError);
  });
});

describe("parseSegmentInput — plan d'effets", () => {
  const validPlan = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 });

  function segmentWith(renderPlan: unknown) {
    return {
      id: "seg-1",
      projectId: "p1",
      title: "Clip",
      startSec: 0,
      endSec: 60,
      words: [{ text: "Bonjour", startSec: 0, endSec: 0.4, speaker: "A", confidence: 0.9 }],
      score: null,
      safeZones: [],
      variants: [],
      renderPlan,
    };
  }

  it("accepts a plan the user edited and keeps its values", () => {
    const parsed = parseSegmentInput(segmentWith({ ...validPlan, templateId: "clean-captions" }));
    expect(parsed.renderPlan?.templateId).toBe("clean-captions");
    expect(parsed.renderPlan?.zoomKeyframes).toEqual(validPlan.zoomKeyframes);
  });

  it("treats a missing plan as none, not as an error", () => {
    expect(parseSegmentInput(segmentWith(null)).renderPlan).toBeNull();
    const { renderPlan: _omitted, ...withoutKey } = segmentWith(null);
    expect(parseSegmentInput(withoutKey).renderPlan).toBeNull();
  });

  /**
   * The plan is compiled into a real ffmpeg filtergraph, so a value out
   * of range has to be refused at the boundary — not clamped quietly,
   * and not discovered at render time.
   */
  it("refuses a plan whose zoom exceeds the declared bounds", () => {
    expect(() =>
      parseSegmentInput(segmentWith({ ...validPlan, zoomKeyframes: [{ tSec: 0, scale: 9 }] }))
    ).toThrow(ProjectInputParseError);
  });

  it("refuses an unknown template id", () => {
    expect(() => parseSegmentInput(segmentWith({ ...validPlan, templateId: "cinematic-ai" }))).toThrow(
      ProjectInputParseError
    );
  });

  it("refuses a structurally broken plan", () => {
    for (const broken of [
      { ...validPlan, subtitleStyle: undefined },
      { ...validPlan, intensity: "fort" },
      { ...validPlan, zoomKeyframes: "beaucoup" },
      { ...validPlan, subtitleStyle: { ...validPlan.subtitleStyle, emphasizeKeywords: "oui" } },
    ]) {
      expect(() => parseSegmentInput(segmentWith(broken))).toThrow(ProjectInputParseError);
    }
  });

  it("accepts a plan whose crop follows the speaker", () => {
    const framing = [
      {
        id: "shot-1",
        startSec: 0,
        endSec: 30,
        rect: { x: 0.05, y: 0, width: 0.5625, height: 1 },
        transitionSec: 0,
        source: "speaker",
        label: "Intervenant A",
      },
      {
        id: "shot-2",
        startSec: 30,
        endSec: 60,
        rect: { x: 0.39, y: 0, width: 0.5625, height: 1 },
        transitionSec: 0.2,
        source: "manual",
        label: null,
      },
    ];
    const parsed = parseSegmentInput(segmentWith({ ...validPlan, framing }));
    expect(parsed.renderPlan?.framing).toHaveLength(2);
    expect(parsed.renderPlan?.framing[1].label).toBeNull();
    expect(parsed.renderPlan?.framing[1].source).toBe("manual");
  });

  it("treats a plan saved before framing existed as a plan with one static crop", () => {
    const { framing: _omitted, ...beforeFraming } = validPlan;
    expect(parseSegmentInput(segmentWith(beforeFraming)).renderPlan?.framing).toEqual([]);
  });

  it("refuses an unknown framing source", () => {
    const framing = [
      {
        id: "shot-1",
        startSec: 0,
        endSec: 30,
        rect: { x: 0.05, y: 0, width: 0.5625, height: 1 },
        transitionSec: 0,
        source: "ia-magique",
        label: null,
      },
    ];
    expect(() => parseSegmentInput(segmentWith({ ...validPlan, framing }))).toThrow(ProjectInputParseError);
  });

  it("refuses a framing window that leaves the source frame", () => {
    const framing = [
      {
        id: "shot-1",
        startSec: 0,
        endSec: 30,
        rect: { x: 0.8, y: 0, width: 0.5625, height: 1 },
        transitionSec: 0,
        source: "speaker",
        label: null,
      },
    ];
    expect(() => parseSegmentInput(segmentWith({ ...validPlan, framing }))).toThrow(ProjectInputParseError);
  });

  it("never takes the limitations from the client: what the export cannot do is the server's word", () => {
    const parsed = parseSegmentInput(
      segmentWith({ ...validPlan, limitations: ["PeakCut fait absolument tout"] })
    );
    expect(parsed.renderPlan?.limitations).toEqual(COMMON_LIMITATIONS);
  });
});
