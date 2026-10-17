// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { SqliteJobRepository } from "./JobRepository";
import { runJobWorker, type JobHandlers } from "./worker";
import { attachChain, nextChainedJob } from "./chain";
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

describe("runJobWorker — chained pipeline", () => {
  const chainedPayload = () =>
    attachChain({ url: "https://youtu.be/x" }, [
      { kind: "transcription" as const, payload: { providerId: "openai" } },
      { kind: "analysis" as const, payload: {} },
      { kind: "tracking" as const, payload: {} },
    ]);

  function queueChainHead(repo: SqliteJobRepository, projectId: string) {
    repo.createJob({
      id: "job-head",
      projectId,
      kind: "download",
      payload: chainedPayload(),
      now: "2026-01-01T00:00:00.000Z",
    });
  }

  it("enqueues the next step when a chained job succeeds", async () => {
    const { repo, project } = setup();
    queueChainHead(repo, project.id);

    const result = await runJobWorker({
      repo,
      handlers: noopHandlers({ download: async () => ({ ok: true }) }),
      once: true,
      newId: () => "job-next",
    });

    expect(result.chained).toBe(1);
    const next = repo.getJobById("job-next");
    expect(next?.kind).toBe("transcription");
    expect(next?.status).toBe("queued");
    expect(next?.projectId).toBe(project.id);
    expect((next?.payload as { providerId?: string }).providerId).toBe("openai");
  });

  it("runs the whole pipeline in order, each step enqueued by the previous one", async () => {
    const { repo, project } = setup();
    queueChainHead(repo, project.id);

    const ran: string[] = [];
    const record = (kind: string) => async () => {
      ran.push(kind);
      return { kind };
    };
    let id = 0;
    const result = await runJobWorker({
      repo,
      handlers: {
        download: record("download"),
        transcription: record("transcription"),
        analysis: record("analysis"),
        tracking: record("tracking"),
        render: record("render"),
      },
      maxIterations: 10,
      newId: () => `chained-${++id}`,
      pollIntervalMs: 0,
      signal: AbortSignal.timeout(2000),
    });

    expect(ran).toEqual(["download", "transcription", "analysis", "tracking"]);
    expect(result.chained).toBe(3);
  });

  it("stops the pipeline at the step that failed, enqueueing nothing downstream", async () => {
    const { repo, project } = setup();
    queueChainHead(repo, project.id);

    const transcription = vi.fn();
    await runJobWorker({
      repo,
      handlers: noopHandlers({
        download: async () => {
          throw new Error("yt-dlp indisponible");
        },
        transcription,
      }),
      maxIterations: 4,
      newId: () => "never-created",
      pollIntervalMs: 0,
    });

    expect(transcription).not.toHaveBeenCalled();
    expect(repo.getJobById("never-created")).toBeNull();
    // Retried until its attempts ran out, then terminally failed — and at
    // no point did a success, and so a chained step, happen.
    expect(repo.getJobById("job-head")?.status).toBe("failed");
  });

  it("never enqueues the same step twice, even if the head job is processed again", async () => {
    const { repo, project } = setup();
    queueChainHead(repo, project.id);
    const head = repo.getJobById("job-head")!;

    // Simulate the worker reaching the chaining step twice for one job
    // (a crash-and-retry between succeedJob and createJob).
    const first = nextChainedJob(head)!;
    const second = nextChainedJob(head)!;
    repo.createJob({ id: "a", projectId: project.id, kind: first.kind, payload: first.payload, idempotencyKey: first.idempotencyKey, now: "t" });
    const duplicate = repo.createJob({ id: "b", projectId: project.id, kind: second.kind, payload: second.payload, idempotencyKey: second.idempotencyKey, now: "t" });

    expect(duplicate.created).toBe(false);
    expect(repo.getJobById("b")).toBeNull();
  });

  it("leaves an unchained job alone", async () => {
    const { repo, project } = setup();
    repo.createJob({ id: "solo", projectId: project.id, kind: "analysis", payload: {}, now: "t" });

    const result = await runJobWorker({
      repo,
      handlers: noopHandlers({ analysis: async () => ({ segments: [] }) }),
      once: true,
    });

    expect(result.chained).toBe(0);
  });
});
