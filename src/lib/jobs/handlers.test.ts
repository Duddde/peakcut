// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow, confirmRights, authorizeExport } from "@/lib/workflow/workflow";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import { buildDefaultVariants } from "@/lib/domain/defaultVariants";
import { createDefaultJobHandlers } from "./handlers";
import { SqliteJobRepository } from "./JobRepository";
import { TranscriptProviderNotConfiguredError } from "@/lib/transcript/TranscriptProvider";
import type { TranscriptProvider } from "@/lib/transcript/TranscriptProvider";
import type { Project, Segment } from "@/lib/domain/types";
import type { FrameTracker, FrameTrack } from "@/lib/tracking/types";

function baseProject(overrides: Partial<Project> = {}): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "proj-1",
    title: "Projet",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: "s0",
      type: "local-upload",
      title: "clip.mp4",
      localFilePath: "/data/uploads/clip.mp4",
      durationSec: 30,
      originTimestamp: now,
      confidence: 1,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
    ...overrides,
  };
}

function makeSegment(id: string, startSec: number, endSec: number): Segment {
  const words = [
    { text: "Bonjour", startSec, endSec: startSec + 0.3, speaker: "A", confidence: 0.9 },
    { text: "monde", startSec: startSec + 0.4, endSec: startSec + 0.8, speaker: "A", confidence: 0.9 },
  ];
  return {
    id,
    projectId: "proj-1",
    title: "Segment",
    startSec,
    endSec,
    words,
    score: scoreSegment({ words, startSec, endSec }),
    safeZones: buildDefaultSafeZones(id),
    variants: buildDefaultVariants(id),
  };
}

async function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const projects = new SqliteProjectRepository(db);
  const jobs = new SqliteJobRepository(db);
  const owner = users.createUser("owner@example.com", "hash");
  const exportsBaseDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-"));
  return { db, projects, jobs, owner, exportsBaseDir };
}

class StubProvider implements TranscriptProvider {
  readonly id = "stub-provider";
  readonly displayName = "Stub";
  async transcribe() {
    return {
      language: "fr",
      providerId: this.id,
      words: [
        { text: "un", startSec: 0, endSec: 0.5, speaker: "A", confidence: 0.9 },
        { text: "deux", startSec: 0.6, endSec: 1.1, speaker: "A", confidence: 0.9 },
      ],
    };
  }
}

class UnconfiguredProvider implements TranscriptProvider {
  readonly id = "cloud-unconfigured";
  readonly displayName = "Cloud";
  async transcribe(): Promise<never> {
    throw new TranscriptProviderNotConfiguredError(this.id, "CLOUD_API_KEY");
  }
}

function makeFakeTracker(track: FrameTrack): FrameTracker {
  return {
    id: "fake-tracker",
    displayName: "Fake",
    track: async () => track,
  };
}

describe("createDefaultJobHandlers", () => {
  it("transcription persists the transcript onto the project when projectId is set", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, providers: [new StubProvider()] });

      const { job } = jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "transcription",
        payload: { providerId: "stub-provider" },
        now: "2026-01-01T00:00:00.000Z",
      });
      const claimed = jobs.claimNextJob()!;
      expect(claimed.id).toBe(job.id);

      const result = (await handlers.transcription({ job: claimed, reportProgress: () => {} })) as {
        transcript: { words: unknown[] };
      };
      expect(result.transcript.words).toHaveLength(2);

      const persisted = projects.getProjectById(project.id);
      expect(persisted?.transcript?.words).toHaveLength(2);
      expect(persisted?.transcript?.providerId).toBe("stub-provider");
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("transcription fails honestly (never a simulated success) when the provider isn't configured", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, providers: [new UnconfiguredProvider()] });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "transcription",
        payload: { providerId: "cloud-unconfigured" },
        now: "2026-01-01T00:00:00.000Z",
      });
      const claimed = jobs.claimNextJob()!;

      await expect(handlers.transcription({ job: claimed, reportProgress: () => {} })).rejects.toThrow(
        TranscriptProviderNotConfiguredError
      );
      expect(projects.getProjectById(project.id)?.transcript).toBeNull();
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("analysis rescores each existing segment's own words and persists them, without re-slicing from the full transcript", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const segment = makeSegment("seg-1", 0, 0.8);
      // Simulate a manual edit: the segment's own words differ from what the
      // full transcript would produce for this time range.
      segment.words = [{ text: "édité", startSec: 0, endSec: 0.5, speaker: "A", confidence: 0.9 }];
      const project = baseProject({
        segments: [segment],
        transcript: { language: "fr", providerId: "mock", words: [{ text: "autre", startSec: 0, endSec: 0.5, speaker: "A", confidence: 0.9 }] },
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.analysis({ job: claimed, reportProgress: () => {} })) as {
        segments: Array<{ words: Array<{ text: string }> }>;
      };

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].words[0].text).toBe("édité");

      const persisted = projects.getProjectById(project.id);
      expect(persisted?.segments[0].words[0].text).toBe("édité");
      expect(persisted?.segments[0].score).not.toBeNull();
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("analysis derives one whole-transcript segment when there are zero segments yet", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        transcript: {
          language: "fr",
          providerId: "mock",
          words: [{ text: "bonjour", startSec: 0, endSec: 0.5, speaker: "A", confidence: 0.9 }],
        },
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.analysis({ job: claimed, reportProgress: () => {} })) as { segments: unknown[] };

      expect(result.segments).toHaveLength(1);
      expect(projects.getProjectById(project.id)?.segments).toHaveLength(1);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("analysis fails honestly when there is neither a transcript nor any segment", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;

      await expect(handlers.analysis({ job: claimed, reportProgress: () => {} })).rejects.toThrow();
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("tracking derives a per-variant crop from the track and persists it onto every segment", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-video-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);

      const segment = makeSegment("seg-1", 0, 2);
      const project = baseProject({
        segments: [segment],
        source: { ...baseProject().source, localFilePath: sourcePath },
      });
      projects.createProject(owner.id, project);

      const track: FrameTrack = {
        keyframes: [{ tSec: 0, cx: 0.8, cy: 0.5, confidence: 0.9 }],
        fallbackUsed: false,
        method: "fake-real-detector",
      };
      const handlers = createDefaultJobHandlers({
        db,
        exportsBaseDir,
        trackerFactory: () => makeFakeTracker(track),
      });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: { provider: "local-subject" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.tracking({ job: claimed, reportProgress: () => {} })) as {
        appliedToSegments: boolean;
        track: FrameTrack;
      };

      expect(result.appliedToSegments).toBe(true);
      expect(result.track.fallbackUsed).toBe(false);

      const persisted = projects.getProjectById(project.id);
      const verticalVariant = persisted?.segments[0].variants.find((v) => v.aspectRatio === "9:16");
      // cx = 0.8 should shift the crop window to the right of a plain centered crop.
      expect(verticalVariant?.crop.x).toBeGreaterThan(0);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);

  it("render fails honestly (no file written, no fake success) when export isn't authorized", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const segment = makeSegment("seg-1", 0, 1);
      const project = baseProject({ segments: [segment] }); // workflow not authorized yet
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: { segmentId: "seg-1" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;

      await expect(handlers.render({ job: claimed, reportProgress: () => {} })).rejects.toThrow(/non autorisé/i);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("render generates and verifies a real mp4 once export is authorized", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-video-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);

      const segment = makeSegment("seg-1", 0, 2);
      const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "reviewer@example.com"));
      const project = baseProject({
        segments: [segment],
        source: { ...baseProject().source, localFilePath: sourcePath, durationSec: 3 },
        workflow,
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: { segmentId: "seg-1" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;

      let lastProgress = 0;
      const result = (await handlers.render({
        job: claimed,
        reportProgress: (p) => {
          lastProgress = p;
        },
      })) as { outputPath: string; durationSec: number };

      expect(result.outputPath).toContain(exportsBaseDir);
      expect(result.durationSec).toBeGreaterThan(0);
      expect(lastProgress).toBeGreaterThan(0);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);
});
