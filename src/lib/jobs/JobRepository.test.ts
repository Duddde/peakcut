// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { SqliteJobRepository } from "./JobRepository";
import type { Project } from "@/lib/domain/types";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const projects = new SqliteProjectRepository(db);
  const jobs = new SqliteJobRepository(db);
  const owner = users.createUser("owner@example.com", "hash");
  const now = "2026-01-01T00:00:00.000Z";
  const project: Project = {
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
  };
  projects.createProject(owner.id, project);
  return { db, jobs, projects, owner, project };
}

describe("SqliteJobRepository", () => {
  it("creates a queued job with progress 0 and attempts 0", () => {
    const { jobs, project } = setup();
    const { job, created } = jobs.createJob({
      id: "job-1",
      projectId: project.id,
      kind: "transcription",
      payload: { providerId: "mock-deterministic" },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.progress).toBe(0);
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.payload).toEqual({ providerId: "mock-deterministic" });
    expect(job.result).toBeNull();
  });

  it("is idempotent: a repeated create with the same idempotencyKey returns the existing job instead of a duplicate", () => {
    const { jobs, project } = setup();
    const first = jobs.createJob({
      id: "job-1",
      projectId: project.id,
      kind: "analysis",
      payload: {},
      idempotencyKey: "req-abc",
      now: "2026-01-01T00:00:00.000Z",
    });
    const second = jobs.createJob({
      id: "job-2",
      projectId: project.id,
      kind: "analysis",
      payload: { different: true },
      idempotencyKey: "req-abc",
      now: "2026-01-01T00:05:00.000Z",
    });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(jobs.getJobById("job-2")).toBeNull();
  });

  it("allows multiple jobs with no idempotencyKey", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    const { created } = jobs.createJob({
      id: "job-2",
      projectId: project.id,
      kind: "analysis",
      payload: {},
      now: "2026-01-01T00:01:00.000Z",
    });
    expect(created).toBe(true);
  });

  it("claims the oldest queued job atomically, marking it running and incrementing attempts", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.createJob({ id: "job-2", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:01:00.000Z" });

    const claimed = jobs.claimNextJob();
    expect(claimed?.id).toBe("job-1");
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).not.toBeNull();

    const secondClaim = jobs.claimNextJob();
    expect(secondClaim?.id).toBe("job-2");
  });

  it("claimNextJob returns null when no job is queued", () => {
    const { jobs } = setup();
    expect(jobs.claimNextJob()).toBeNull();
  });

  it("claimNextJob restricts to the given kinds", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "transcription", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.createJob({ id: "job-2", projectId: project.id, kind: "render", payload: {}, now: "2026-01-01T00:01:00.000Z" });

    const claimed = jobs.claimNextJob(["render"]);
    expect(claimed?.id).toBe("job-2");
  });

  it("updateProgress only applies to a running job", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });

    expect(jobs.updateProgress("job-1", 50, "2026-01-01T00:01:00.000Z")).toBe(false);

    jobs.claimNextJob();
    expect(jobs.updateProgress("job-1", 150, "2026-01-01T00:02:00.000Z")).toBe(true);
    expect(jobs.getJobById("job-1")?.progress).toBe(100);

    expect(jobs.updateProgress("job-1", -10, "2026-01-01T00:03:00.000Z")).toBe(true);
    expect(jobs.getJobById("job-1")?.progress).toBe(0);
  });

  it("succeedJob stores the result and marks progress 100, only for a running job", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });

    expect(jobs.succeedJob("job-1", { ok: true }, "2026-01-01T00:01:00.000Z")).toBe(false);

    jobs.claimNextJob();
    expect(jobs.succeedJob("job-1", { segments: [] }, "2026-01-01T00:02:00.000Z")).toBe(true);
    const job = jobs.getJobById("job-1");
    expect(job?.status).toBe("succeeded");
    expect(job?.progress).toBe(100);
    expect(job?.result).toEqual({ segments: [] });
    expect(job?.finishedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("failJob requeues the job while attempts remain below maxAttempts", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, maxAttempts: 3, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();

    const result = jobs.failJob("job-1", "TranscriptError", "boom", "2026-01-01T00:01:00.000Z");
    expect(result).toEqual({ requeued: true, applied: true });

    const job = jobs.getJobById("job-1");
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.errorMessage).toBe("boom");
    expect(job?.startedAt).toBeNull();
  });

  it("failJob terminally fails the job once maxAttempts is reached", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, maxAttempts: 1, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();

    const result = jobs.failJob("job-1", "TranscriptError", "boom", "2026-01-01T00:01:00.000Z");
    expect(result).toEqual({ requeued: false, applied: true });

    const job = jobs.getJobById("job-1");
    expect(job?.status).toBe("failed");
    expect(job?.finishedAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("failJob is a no-op when the job is not running (e.g. already cancelled)", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();
    jobs.cancelJob("job-1", "2026-01-01T00:01:00.000Z");

    const result = jobs.failJob("job-1", "Err", "boom", "2026-01-01T00:02:00.000Z");
    expect(result).toEqual({ requeued: false, applied: false });
    expect(jobs.getJobById("job-1")?.status).toBe("cancelled");
  });

  it("cancelJob cancels a queued job", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    expect(jobs.cancelJob("job-1", "2026-01-01T00:01:00.000Z")).toBe(true);
    expect(jobs.getJobById("job-1")?.status).toBe("cancelled");
  });

  it("cancelJob cancels a running job", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();
    expect(jobs.cancelJob("job-1", "2026-01-01T00:01:00.000Z")).toBe(true);
    expect(jobs.getJobById("job-1")?.status).toBe("cancelled");
  });

  it("cancelJob does not apply to an already-terminal job", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();
    jobs.succeedJob("job-1", {}, "2026-01-01T00:01:00.000Z");

    expect(jobs.cancelJob("job-1", "2026-01-01T00:02:00.000Z")).toBe(false);
    expect(jobs.getJobById("job-1")?.status).toBe("succeeded");
  });

  it("a cancelled-while-running job silently rejects a late succeedJob from the worker", () => {
    const { jobs, project } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "render", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.claimNextJob();
    jobs.cancelJob("job-1", "2026-01-01T00:01:00.000Z");

    expect(jobs.succeedJob("job-1", { outputPath: "x" }, "2026-01-01T00:02:00.000Z")).toBe(false);
    expect(jobs.getJobById("job-1")?.status).toBe("cancelled");
  });

  it("getJobOwnerId resolves the project owner, and is null for a nonexistent job", () => {
    const { jobs, project, owner } = setup();
    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    expect(jobs.getJobOwnerId("job-1")).toBe(owner.id);
    expect(jobs.getJobOwnerId("does-not-exist")).toBeNull();
  });

  it("listJobsByProject returns only that project's jobs, newest first", () => {
    const { jobs, projects, project, owner } = setup();
    const otherProject: Project = { ...project, id: "proj-2" };
    projects.createProject(owner.id, otherProject);

    jobs.createJob({ id: "job-1", projectId: project.id, kind: "analysis", payload: {}, now: "2026-01-01T00:00:00.000Z" });
    jobs.createJob({ id: "job-2", projectId: project.id, kind: "render", payload: {}, now: "2026-01-01T00:01:00.000Z" });
    jobs.createJob({ id: "job-3", projectId: otherProject.id, kind: "analysis", payload: {}, now: "2026-01-01T00:02:00.000Z" });

    const list = jobs.listJobsByProject(project.id);
    expect(list.map((j) => j.id)).toEqual(["job-2", "job-1"]);
  });
});

describe("createJob — idempotence et relance après échec", () => {
  /**
   * The key exists so a double click does not run the same work twice.
   * It must not also mean "this has failed once, so it can never be
   * attempted again": the user saw the dead job's old error replayed at
   * every click, with no way out even after the cause was fixed.
   */
  function enqueue(repo: SqliteJobRepository, id: string, now: string) {
    return repo.createJob({
      id,
      projectId: null,
      kind: "transcription",
      payload: { providerId: "openai-gpt-4o-transcribe-diarize" },
      idempotencyKey: "transcription:projet:source:openai",
      now,
    });
  }

  it("returns the existing job while it is still queued", () => {
    const { jobs: repo } = setup();
    const first = enqueue(repo, "job-1", "2026-01-01T00:00:00.000Z");
    const second = enqueue(repo, "job-2", "2026-01-01T00:00:01.000Z");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe("job-1");
  });

  it("returns the existing job once it has succeeded, instead of redoing the work", () => {
    const { jobs: repo } = setup();
    enqueue(repo, "job-1", "2026-01-01T00:00:00.000Z");
    repo.claimNextJob();
    repo.succeedJob("job-1", { ok: true }, "2026-01-01T00:00:02.000Z");

    const again = enqueue(repo, "job-2", "2026-01-01T00:00:03.000Z");
    expect(again.created).toBe(false);
    expect(again.job.id).toBe("job-1");
    expect(again.job.status).toBe("succeeded");
  });

  it("creates a fresh job after a terminal failure, so a fixed cause can be retried", () => {
    const { jobs: repo } = setup();
    enqueue(repo, "job-1", "2026-01-01T00:00:00.000Z");
    repo.claimNextJob();
    repo.failJob("job-1", "TranscriptHttpError", "chunking_strategy is required", "2026-01-01T00:00:02.000Z");
    repo.claimNextJob();
    repo.failJob("job-1", "TranscriptHttpError", "chunking_strategy is required", "2026-01-01T00:00:03.000Z");
    repo.claimNextJob();
    repo.failJob("job-1", "TranscriptHttpError", "chunking_strategy is required", "2026-01-01T00:00:04.000Z");
    expect(repo.getJobById("job-1")?.status).toBe("failed");

    const retry = enqueue(repo, "job-2", "2026-01-01T00:00:05.000Z");

    expect(retry.created).toBe(true);
    expect(retry.job.id).toBe("job-2");
    expect(retry.job.status).toBe("queued");
    // The failed attempt is kept for history, but no longer owns the key.
    expect(repo.getJobById("job-1")?.status).toBe("failed");
  });

  it("creates a fresh job after a cancellation too", () => {
    const { jobs: repo } = setup();
    enqueue(repo, "job-1", "2026-01-01T00:00:00.000Z");
    repo.cancelJob("job-1", "2026-01-01T00:00:01.000Z");

    const retry = enqueue(repo, "job-2", "2026-01-01T00:00:02.000Z");
    expect(retry.created).toBe(true);
    expect(retry.job.status).toBe("queued");
  });
});
