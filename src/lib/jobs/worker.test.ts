// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { SqliteJobRepository } from "./JobRepository";
import { runJobWorker, type JobHandlers } from "./worker";
import type { Project } from "@/lib/domain/types";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const projects = new SqliteProjectRepository(db);
  const repo = new SqliteJobRepository(db);
  const owner = users.createUser("owner@example.com", "hash");
  const now = "2026-01-01T00:00:00.000Z";
  const project: Project = {
    id: "proj-1",
    title: "Projet",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: { id: "s0", type: "local-upload", title: "clip.mp4", durationSec: 30, originTimestamp: now, confidence: 1 },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
  projects.createProject(owner.id, project);
  return { repo, project };
}

function noopHandlers(overrides: Partial<JobHandlers> = {}): JobHandlers {
  const alwaysThrow = async () => {
    throw new Error("not implemented for this test");
  };
  return {
    download: alwaysThrow,
    transcription: alwaysThrow,
    analysis: alwaysThrow,
    tracking: alwaysThrow,
    render: alwaysThrow,
    ...overrides,
  };
}

describe("runJobWorker", () => {
  it("with --once and no queued job, processes nothing and returns immediately", async () => {
    const { repo } = setup();
    const result = await runJobWorker({ repo, handlers: noopHandlers(), once: true });
    expect(result.processed).toBe(0);
  });

  it("with --once, claims and succeeds exactly one job", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    repo.createJob({ id: "job-2", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:01:00.000Z" });

    const analysisHandler = vi.fn().mockResolvedValue({ segments: [] });
    const result = await runJobWorker({ repo, handlers: noopHandlers({ analysis: analysisHandler }), once: true });

    expect(result.processed).toBe(1);
    expect(analysisHandler).toHaveBeenCalledTimes(1);
    expect(repo.getJobById("job-1")?.status).toBe("succeeded");
    expect(repo.getJobById("job-2")?.status).toBe("queued");
  });

  it("dispatches to the handler matching the job's kind", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: { segmentId: "seg-1" }, now: "2026-01-01T00:00:00.000Z" });

    const renderHandler = vi.fn().mockResolvedValue({ outputPath: "unused" });
    await runJobWorker({ repo, handlers: noopHandlers({ render: renderHandler }), once: true });

    expect(renderHandler).toHaveBeenCalledTimes(1);
    const ctx = renderHandler.mock.calls[0][0];
    expect(ctx.job.payload).toEqual({ segmentId: "seg-1" });
  });

  it("a handler failure is turned into a requeue when attempts remain", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: {}, maxAttempts: 3, now: "2026-01-01T00:00:00.000Z" });

    const trackingHandler = vi.fn().mockRejectedValue(new Error("no detector available"));
    await runJobWorker({ repo, handlers: noopHandlers({ tracking: trackingHandler }), once: true });

    const job = repo.getJobById("job-1");
    expect(job?.status).toBe("queued");
    expect(job?.errorMessage).toBe("no detector available");
    expect(job?.attempts).toBe(1);
  });

  it("a handler failure is turned into a terminal failure once maxAttempts is exhausted", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "tracking", payload: {}, maxAttempts: 1, now: "2026-01-01T00:00:00.000Z" });

    await runJobWorker({ repo, handlers: noopHandlers({ tracking: async () => { throw new Error("boom"); } }), once: true });

    expect(repo.getJobById("job-1")?.status).toBe("failed");
  });

  it("reportProgress persists intermediate progress via the repository", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: {}, now: "2026-01-01T00:00:00.000Z" });

    let seenDuringRun: number | undefined;
    await runJobWorker({
      repo,
      handlers: noopHandlers({
        render: async ({ reportProgress }) => {
          reportProgress(42);
          seenDuringRun = repo.getJobById("job-1")?.progress;
          return { done: true };
        },
      }),
      once: true,
    });

    expect(seenDuringRun).toBe(42);
    expect(repo.getJobById("job-1")?.status).toBe("succeeded");
  });

  it("processes multiple queued jobs across iterations when once is false, bounded by maxIterations", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    repo.createJob({ id: "job-2", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:01:00.000Z" });

    const result = await runJobWorker({
      repo,
      handlers: noopHandlers({ analysis: async () => ({ ok: true }) }),
      once: false,
      maxIterations: 2,
      pollIntervalMs: 0,
    });

    expect(result.processed).toBe(2);
    expect(repo.getJobById("job-1")?.status).toBe("succeeded");
    expect(repo.getJobById("job-2")?.status).toBe("succeeded");
  });

  it("stops immediately when the abort signal is already aborted", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    const controller = new AbortController();
    controller.abort();

    const result = await runJobWorker({ repo, handlers: noopHandlers(), signal: controller.signal });
    expect(result.processed).toBe(0);
    expect(repo.getJobById("job-1")?.status).toBe("queued");
  });
});
