// @vitest-environment node
import type { ReadAudioEnvelope } from "@/lib/ffmpeg/audioEnvelope";
import { describe, expect, it, vi } from "vitest";
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
import { VideoDownloadError, type VideoDownloader, type VideoDownloadResult } from "@/lib/youtube/videoDownloader";
import type { Project, Segment, TranscriptWord } from "@/lib/domain/types";
import type { FrameTracker, FrameTrack } from "@/lib/tracking/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";

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

/**
 * `sentenceCount` two-second sentences, each closing on a period so
 * segmentTranscript has real boundaries to cut on.
 */
function longTranscriptWords(sentenceCount: number) {
  const words = [];
  for (let s = 0; s < sentenceCount; s++) {
    for (let w = 0; w < 4; w++) {
      const startSec = s * 2 + w * 0.5;
      words.push({
        text: w === 3 ? `mot${s}.` : `mot${s}x${w}`,
        startSec,
        endSec: startSec + 0.5,
        speaker: "A",
        confidence: 0.9,
      });
    }
  }
  return words;
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
    renderPlan: null,
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

function makeFakeDownloader(
  overrides: Partial<VideoDownloadResult> = {}
): VideoDownloader & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async download(request) {
      urls.push(request.url);
      request.onProgress?.(50);
      return {
        storedPath: "/data/downloads/abc/dQw4w9WgXcQ.mp4",
        sizeBytes: 1024,
        title: "Une conference",
        durationSec: 720,
        videoId: "dQw4w9WgXcQ",
        ...overrides,
      };
    },
  };
}

function makeFakeTracker(track: FrameTrack): FrameTracker {
  return {
    id: "fake-tracker",
    displayName: "Fake",
    track: async () => track,
  };
}

describe("createDefaultJobHandlers", () => {
  it("download fetches the project's YouTube source and persists it as the new local file", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const videoDownloader = makeFakeDownloader();
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, videoDownloader });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "download",
        payload: { url: "https://youtu.be/dQw4w9WgXcQ" },
        now: "2026-01-01T00:00:00.000Z",
      });
      const claimed = jobs.claimNextJob()!;
      const progress: number[] = [];

      const result = (await handlers.download({
        job: claimed,
        reportProgress: (p) => progress.push(p),
      })) as { videoId: string; normalizedUrl: string };

      expect(result.videoId).toBe("dQw4w9WgXcQ");
      expect(videoDownloader.urls).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
      expect(progress.at(-1)).toBe(100);

      const persisted = projects.getProjectById(project.id);
      expect(persisted?.source.type).toBe("youtube");
      expect(persisted?.source.youtubeUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(persisted?.source.localFilePath).toBe("/data/downloads/abc/dQw4w9WgXcQ.mp4");
      expect(persisted?.source.durationSec).toBe(720);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("download falls back to the URL already registered on the project", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        source: {
          id: "s0",
          type: "youtube",
          youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          title: "Source enregistree",
          durationSec: 0,
          originTimestamp: "2026-01-01T00:00:00.000Z",
          confidence: 0.5,
        },
      });
      projects.createProject(owner.id, project);
      const videoDownloader = makeFakeDownloader();
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, videoDownloader });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "download", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      await handlers.download({ job: jobs.claimNextJob()!, reportProgress: () => {} });

      expect(videoDownloader.urls).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("download resets the workflow so a fetched source grants no export right", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        workflow: authorizeExport(confirmRights(createInitialWorkflow(), "alice@example.com")),
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, videoDownloader: makeFakeDownloader() });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "download",
        payload: { url: "https://youtu.be/dQw4w9WgXcQ" },
        now: "2026-01-01T00:00:00.000Z",
      });
      await handlers.download({ job: jobs.claimNextJob()!, reportProgress: () => {} });

      const persisted = projects.getProjectById(project.id);
      expect(persisted?.workflow.phase).toBe("analysis_preview");
      expect(persisted?.workflow.rights.confirmed).toBe(false);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("download keeps the project's existing segments", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({ segments: [makeSegment("seg-1", 0, 5)] });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, videoDownloader: makeFakeDownloader() });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "download",
        payload: { url: "https://youtu.be/dQw4w9WgXcQ" },
        now: "2026-01-01T00:00:00.000Z",
      });
      await handlers.download({ job: jobs.claimNextJob()!, reportProgress: () => {} });

      expect(projects.getProjectById(project.id)?.segments).toHaveLength(1);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("download fails when there is no URL to fetch at all", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, videoDownloader: makeFakeDownloader() });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "download", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      await expect(
        handlers.download({ job: jobs.claimNextJob()!, reportProgress: () => {} })
      ).rejects.toThrow(/Aucune URL YouTube/);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("download leaves the project untouched when the fetch fails", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject();
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({
        db,
        exportsBaseDir,
        videoDownloader: {
          download: async () => {
            throw new VideoDownloadError("video-unavailable", "Video privee.");
          },
        },
      });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "download",
        payload: { url: "https://youtu.be/dQw4w9WgXcQ" },
        now: "2026-01-01T00:00:00.000Z",
      });
      await expect(
        handlers.download({ job: jobs.claimNextJob()!, reportProgress: () => {} })
      ).rejects.toBeInstanceOf(VideoDownloadError);

      expect(projects.getProjectById(project.id)?.source.type).toBe("local-upload");
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

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

  it("analysis cuts several candidate clips from the transcript when there are zero segments yet", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        transcript: { language: "fr", providerId: "mock", words: longTranscriptWords(120) },
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.analysis({ job: claimed, reportProgress: () => {} })) as {
        segments: { startSec: number; endSec: number }[];
      };

      expect(result.segments.length).toBeGreaterThan(1);
      // None of them spans the whole transcript the way the old single
      // whole-transcript segment did.
      const total = 120 * 2;
      for (const segment of result.segments) {
        expect(segment.endSec - segment.startSec).toBeLessThan(total);
      }
      expect(projects.getProjectById(project.id)?.segments.length).toBe(result.segments.length);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("analysis re-cuts from the transcript only when payload.resegment is set, replacing the existing segments", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        transcript: { language: "fr", providerId: "mock", words: longTranscriptWords(120) },
        segments: [
          {
            id: "hand-edited",
            projectId: "p1",
            title: "Retouché à la main",
            startSec: 0,
            endSec: 20,
            words: longTranscriptWords(10),
            score: null,
            safeZones: [],
            variants: [],
            renderPlan: null,
          },
        ],
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      // Without the flag: the hand-edited segment survives, merely rescored.
      jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
      const rescored = (await handlers.analysis({
        job: jobs.claimNextJob()!,
        reportProgress: () => {},
      })) as { segments: { id: string; title: string }[] };
      expect(rescored.segments).toHaveLength(1);
      expect(rescored.segments[0].id).toBe("hand-edited");

      // With it: replaced by freshly cut candidates.
      jobs.createJob({
        id: "job-2",
        projectId: project.id,
        kind: "analysis",
        payload: { resegment: true },
        now: "2026-01-01T00:00:01.000Z",
      });
      const recut = (await handlers.analysis({
        job: jobs.claimNextJob()!,
        reportProgress: () => {},
      })) as { segments: { id: string }[] };
      expect(recut.segments.length).toBeGreaterThan(1);
      expect(recut.segments.some((s) => s.id === "hand-edited")).toBe(false);
      expect(projects.getProjectById(project.id)?.segments.some((s) => s.id === "hand-edited")).toBe(false);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
    }
  });

  it("analysis refuses payload.resegment when the project has no transcript to cut from", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    try {
      const project = baseProject({
        segments: [
          {
            id: "only-segment",
            projectId: "p1",
            title: "Segment",
            startSec: 0,
            endSec: 20,
            words: longTranscriptWords(10),
            score: null,
            safeZones: [],
            variants: [],
            renderPlan: null,
          },
        ],
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({
        id: "job-1",
        projectId: project.id,
        kind: "analysis",
        payload: { resegment: true },
        now: "2026-01-01T00:00:00.000Z",
      });
      await expect(
        handlers.analysis({ job: jobs.claimNextJob()!, reportProgress: () => {} })
      ).rejects.toThrow(/transcription/i);
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

  /**
   * Two faces, one of which moves its mouth while each voice is talking:
   * the one case where a clip can really be framed on the speaker. The
   * detection is faked (a real Haar cascade on a synthetic video would
   * detect nothing), but everything downstream of it is the real code
   * path — matching, shot building, bounds, persistence.
   */
  it("tracking frames the clip on whoever is speaking and saves the shots onto the plan", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-framing-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);

      const words: TranscriptWord[] = [];
      for (let t = 0; t < 60; t++) {
        words.push({
          text: t % 2 === 0 ? "oui" : "non",
          startSec: t,
          endSec: t + 0.9,
          speaker: t < 30 ? "A" : "B",
          confidence: 0.9,
        });
      }

      const segment = {
        ...makeSegment("seg-1", 0, 60),
        words,
        renderPlan: buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 60 }),
      };
      const project = baseProject({
        segments: [segment],
        transcript: { language: "fr", words, providerId: "fake" },
        source: { ...baseProject().source, localFilePath: sourcePath, durationSec: 60 },
      });
      projects.createProject(owner.id, project);

      const boxes = (x: number, speaking: (tSec: number) => boolean) =>
        Array.from({ length: 60 }, (_, tSec) => ({
          tSec,
          x,
          y: 0.3,
          width: 0.12,
          height: 0.2,
          score: 0.9,
          activity: speaking(tSec) ? 0.06 : 0.003,
        }));

      const track: FrameTrack = {
        keyframes: [{ tSec: 0, cx: 0.5, cy: 0.5, confidence: 0.9 }],
        fallbackUsed: false,
        method: "fake-real-detector",
        subjects: [
          { id: "s1", boxes: boxes(0.1, (t) => t < 30) },
          { id: "s2", boxes: boxes(0.75, (t) => t >= 30) },
        ],
      };

      const handlers = createDefaultJobHandlers({
        db,
        exportsBaseDir,
        trackerFactory: () => makeFakeTracker(track),
      });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: { provider: "local-subject" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.tracking({ job: claimed, reportProgress: () => {} })) as {
        speakerFraming: { cutsDetected: number; framedSegments: number; notes: string[] };
        track: FrameTrack;
      };

      expect(result.speakerFraming.framedSegments).toBe(1);
      // The boxes themselves stay out of the stored result.
      expect(result.track.subjects).toBeUndefined();

      const persisted = projects.getProjectById(project.id);
      const framing = persisted!.segments[0].renderPlan!.framing;
      expect(framing).toHaveLength(2);
      expect(framing[0].source).toBe("speaker");
      expect(framing[0].startSec).toBe(0);
      expect(framing[1].endSec).toBe(60);
      // The first speaker is the left face, the second the right one.
      expect(framing[0].rect.x).toBeLessThan(framing[1].rect.x);
      expect(validateRenderPlan(persisted!.segments[0].renderPlan!)).toEqual({ ok: true, errors: [] });
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);

  it("tracking follows an edited show's close-ups across its camera cuts", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-cuts-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);
      const segment = {
        ...makeSegment("seg-1", 0, 12),
        renderPlan: buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 12 }),
      };
      const project = baseProject({
        segments: [segment],
        source: { ...baseProject().source, localFilePath: sourcePath, durationSec: 12 },
      });
      projects.createProject(owner.id, project);

      // Close-ups alternating every 3 s: one face per shot, left then
      // right, each seen in a single detection — the case grouping drops.
      const cuts = [3, 6, 9];
      const detections = [0, 3, 6, 9].map((tSec, i) => ({
        tSec: tSec + 0.1,
        x: i % 2 === 0 ? 0.15 : 0.6,
        y: 0.25,
        width: 0.2,
        height: 0.35,
        score: 0.9,
      }));
      const track: FrameTrack = {
        keyframes: [{ tSec: 0, cx: 0.5, cy: 0.5, confidence: 0.9 }],
        fallbackUsed: false,
        method: "fake-real-detector",
        subjects: [],
        detections,
        cuts,
      };
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir, trackerFactory: () => makeFakeTracker(track) });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: { provider: "local-subject" }, now: "2026-01-01T00:00:00.000Z" });
      const result = (await handlers.tracking({ job: jobs.claimNextJob()!, reportProgress: () => {} })) as {
        speakerFraming: { cutsDetected: number; framedSegments: number };
        track: FrameTrack;
      };

      expect(result.speakerFraming.cutsDetected).toBe(3);
      expect(result.track.detections).toBeUndefined();
      const framing = projects.getProjectById(project.id)!.segments[0].renderPlan!.framing;
      expect(framing.map((shot) => [shot.startSec, shot.endSec])).toEqual([
        [0, 3],
        [3, 6],
        [6, 9],
        [9, 12],
      ]);
      expect(framing[0].rect.x).toBeLessThan(framing[1].rect.x);
      expect(framing[2].rect.x).toBe(framing[0].rect.x);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);

  it("tracking says why the clip is not framed on the speaker rather than leaving it unexplained", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-noframing-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);

      const segment = {
        ...makeSegment("seg-1", 0, 2),
        renderPlan: buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 2 }),
      };
      // No transcript: nothing says who talks when.
      const project = baseProject({
        segments: [segment],
        source: { ...baseProject().source, localFilePath: sourcePath },
      });
      projects.createProject(owner.id, project);

      const track: FrameTrack = {
        keyframes: [{ tSec: 0, cx: 0.5, cy: 0.5, confidence: 0.9 }],
        fallbackUsed: false,
        method: "fake-real-detector",
        subjects: [],
      };
      const handlers = createDefaultJobHandlers({
        db,
        exportsBaseDir,
        trackerFactory: () => makeFakeTracker(track),
      });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: { provider: "local-subject" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.tracking({ job: claimed, reportProgress: () => {} })) as {
        speakerFraming: { cutsDetected: number; framedSegments: number; notes: string[] };
      };

      expect(result.speakerFraming.framedSegments).toBe(0);
      expect(result.speakerFraming.notes.join(" ")).toMatch(/aucun visage/i);

      const persisted = projects.getProjectById(project.id);
      expect(persisted!.segments[0].renderPlan!.framing).toEqual([]);
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

  /**
   * The segment carries the edit the user sees in the studio. Rendering
   * without it produced a file that matched nothing they had chosen.
   */
  it("render applies the segment's own render plan", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const workDir = await mkdtemp(path.join(tmpdir(), "peakcut-handlers-plan-"));
    try {
      const sourcePath = path.join(workDir, "source.mp4");
      await createSyntheticVideo(sourcePath, 3);

      const segment = {
        ...makeSegment("seg-1", 0, 2),
        renderPlan: buildRenderPlan("hook-emphasis", { segmentId: "seg-1", segmentDurationSec: 2 }),
      };
      const project = baseProject({
        segments: [segment],
        source: { ...baseProject().source, localFilePath: sourcePath, durationSec: 3 },
        workflow: authorizeExport(confirmRights(createInitialWorkflow(), "reviewer@example.com")),
      });
      projects.createProject(owner.id, project);
      const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

      jobs.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: { segmentId: "seg-1" }, now: "2026-01-01T00:00:00.000Z" });
      const claimed = jobs.claimNextJob()!;
      const result = (await handlers.render({ job: claimed, reportProgress: () => {} })) as {
        renderApplied: { zoom: boolean; subtitleStyle: boolean; templateId: string | null };
      };

      expect(result.renderApplied.templateId).toBe("hook-emphasis");
      expect(result.renderApplied.zoom).toBe(true);
      expect(result.renderApplied.subtitleStyle).toBe(true);
    } finally {
      await rm(exportsBaseDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);

  it("analysis puts fresh clips' cuts in the audio's pauses, with a plan drawn for the final bounds", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const words = longTranscriptWords(120);
    const project = baseProject({
      segments: [],
      transcript: { language: "fr", providerId: "test", words },
      source: { ...baseProject().source, localFilePath: "/media/source.mp4", durationSec: 300 },
    });
    projects.createProject(owner.id, project);
    // Loud everywhere, except a quiet 0.3 s before every whole second:
    // each clip's start can move back into one of them.
    const readAudioEnvelope: ReadAudioEnvelope = async (_path, startSec, durationSec, frameSec) => {
      const levels: number[] = [];
      for (let t = startSec; t < startSec + durationSec; t += frameSec) {
        const fraction = t + frameSec / 2 - Math.floor(t + frameSec / 2);
        levels.push(fraction > 0.6 && fraction < 0.9 ? 0.01 : 0.3);
      }
      return { startSec, frameSec, levels };
    };
    const handlers = createDefaultJobHandlers({ db, exportsBaseDir, readAudioEnvelope });

    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    const result = (await handlers.analysis({ job: jobs.claimNextJob()!, reportProgress: () => {} })) as {
      segments: Segment[];
    };

    expect(result.segments.length).toBeGreaterThan(0);
    for (const segment of result.segments) {
      // Moved back into the pause before its first word (a clip at the
      // very start of the video has nowhere earlier to go)…
      if (segment.words[0].startSec > 0.5) expect(segment.startSec).toBeLessThan(segment.words[0].startSec);
      else expect(segment.startSec).toBeLessThanOrEqual(segment.words[0].startSec);
      // …and its plan still covers the whole clip, breath included.
      const plan = segment.renderPlan!;
      expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
      expect(plan.cuts[0].startSec).toBe(0);
    }
  });

  it("motion saves the cards Claude designs onto each clip's plan, and only on the clip asked for", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const words = longTranscriptWords(60);
    const plan = (id: string, duration: number) => buildRenderPlan("speaker-focus", { segmentId: id, segmentDurationSec: duration });
    const project = baseProject({
      transcript: { language: "fr", providerId: "test", words },
      segments: [
        { ...makeSegment("seg-1", 0, 20), renderPlan: plan("seg-1", 20) },
        { ...makeSegment("seg-2", 30, 50), renderPlan: plan("seg-2", 20) },
      ],
    });
    projects.createProject(owner.id, project);
    const design = vi.fn(async ({ clipStartSec }: { clipStartSec: number }) => [
      { id: "motion-1", kind: "keyword" as const, text: `Carte ${clipStartSec}`, detail: null, items: [], startSec: 1, endSec: 3, position: "top" as const },
    ]);
    const handlers = createDefaultJobHandlers({ db, exportsBaseDir, motionDesigner: { design } });

    jobs.createJob({ id: "job-1", projectId: project.id, kind: "motion", payload: { segmentId: "seg-2" }, now: "2026-01-01T00:00:00.000Z" });
    await handlers.motion({ job: jobs.claimNextJob()!, reportProgress: () => {} });

    expect(design).toHaveBeenCalledTimes(1);
    expect(design.mock.calls[0][0]).toMatchObject({ clipStartSec: 30, clipEndSec: 50 });
    const saved = projects.getProjectById(project.id)!.segments;
    expect(saved.find((s) => s.id === "seg-1")!.renderPlan!.motion ?? []).toEqual([]);
    const seg2 = saved.find((s) => s.id === "seg-2")!.renderPlan!;
    expect(seg2.motion?.map((c) => c.text)).toEqual(["Carte 30"]);
    expect(validateRenderPlan(seg2)).toEqual({ ok: true, errors: [] });
  });

  it("analysis gives every candidate clip an edit to start from", async () => {
    const { db, projects, jobs, owner, exportsBaseDir } = await setup();
    const words = longTranscriptWords(400);
    const project = baseProject({
      segments: [],
      transcript: { language: "fr", providerId: "test", words },
    });
    projects.createProject(owner.id, project);
    const handlers = createDefaultJobHandlers({ db, exportsBaseDir });

    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    const claimed = jobs.claimNextJob()!;
    const result = (await handlers.analysis({ job: claimed, reportProgress: () => {} })) as {
      segments: Array<{ renderPlan: unknown }>;
    };

    expect(result.segments.length).toBeGreaterThan(0);
    for (const segment of result.segments) {
      expect(validateRenderPlan(segment.renderPlan as never).ok).toBe(true);
    }
    expect(projects.getProjectById(project.id)?.segments[0].renderPlan).not.toBeNull();
  });
});
