// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteProjectRepository } from "./ProjectRepository";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import type { Project, Segment } from "@/lib/domain/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const projects = new SqliteProjectRepository(db);
  const owner = users.createUser("owner@example.com", "hash");
  const otherUser = users.createUser("other@example.com", "hash");
  return { db, projects, owner, otherUser };
}

function buildSegment(id: string, projectId: string): Segment {
  const words = [
    { text: "Bonjour", startSec: 0, endSec: 0.4, speaker: "A", confidence: 0.9 },
    { text: "monde", startSec: 0.5, endSec: 0.9, speaker: "A", confidence: 0.9 },
  ];
  return {
    id,
    projectId,
    title: "Segment de test",
    startSec: 0,
    endSec: 0.9,
    words,
    score: scoreSegment({ words, startSec: 0, endSec: 0.9 }),
    safeZones: [
      {
        id: `${id}-sz`,
        purpose: "subtitle-area",
        label: "Zone sous-titres",
        rect: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
      },
    ],
    renderPlan: null,
    variants: [
      { id: `${id}-v1`, label: "Vertical", aspectRatio: "9:16", crop: { x: 0.34, y: 0, width: 0.32, height: 1 } },
    ],
  };
}

function buildProject(id: string): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: "Projet de test",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: `${id}-source`,
      type: "local-upload",
      title: "clip.mp4",
      localFilePath: "/data/uploads/clip.mp4",
      durationSec: 12.5,
      originTimestamp: now,
      confidence: 1,
    },
    transcript: { language: "fr", providerId: "mock-deterministic", words: buildSegment("seg-tmp", id).words },
    segments: [buildSegment(`${id}-seg-1`, id), buildSegment(`${id}-seg-2`, id)],
    timeline: {
      clips: [{ id: "clip-1", trackKind: "video", segmentId: `${id}-seg-1`, startSec: 0, endSec: 0.9 }],
      totalDurationSec: 0.9,
    },
    workflow: createInitialWorkflow(),
  };
}

describe("SqliteProjectRepository", () => {
  it("round-trips a full project (source, transcript, workflow, segments) exactly", () => {
    const { projects, owner } = setup();
    const project = buildProject("p1");
    projects.createProject(owner.id, project);

    const loaded = projects.getProjectById("p1");
    expect(loaded).toEqual(project);
  });

  it("returns null for a nonexistent project", () => {
    const { projects } = setup();
    expect(projects.getProjectById("nope")).toBeNull();
  });

  it("lists project summaries for the owner, most recently updated first", () => {
    const { projects, owner } = setup();
    const p1 = buildProject("p1");
    const p2 = { ...buildProject("p2"), updatedAt: "2026-02-01T00:00:00.000Z", title: "Deuxième" };
    projects.createProject(owner.id, p1);
    projects.createProject(owner.id, p2);

    const list = projects.listProjectsByOwner(owner.id);
    expect(list.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(list[0]).toEqual({ id: "p2", title: "Deuxième", status: "draft", updatedAt: "2026-02-01T00:00:00.000Z" });
  });

  it("isolates projects between owners: another user's list never includes them", () => {
    const { projects, owner, otherUser } = setup();
    projects.createProject(owner.id, buildProject("p1"));
    expect(projects.listProjectsByOwner(otherUser.id)).toEqual([]);
  });

  it("reports the correct owner id for ownership checks", () => {
    const { projects, owner } = setup();
    projects.createProject(owner.id, buildProject("p1"));
    expect(projects.getProjectOwnerId("p1")).toBe(owner.id);
    expect(projects.getProjectOwnerId("nonexistent")).toBeNull();
  });

  it("updateProject fully replaces segments, source, transcript, and workflow", () => {
    const { projects, owner } = setup();
    const project = buildProject("p1");
    projects.createProject(owner.id, project);

    const updated: Project = {
      ...project,
      title: "Titre modifié",
      updatedAt: "2026-03-01T00:00:00.000Z",
      segments: [buildSegment("p1-seg-new", "p1")],
      source: { ...project.source, title: "nouveau.mp4" },
    };
    projects.updateProject("p1", updated);

    const loaded = projects.getProjectById("p1");
    expect(loaded).toEqual(updated);
    expect(loaded?.segments).toHaveLength(1);
  });

  it("deleteProject removes the project and all of its nested rows", () => {
    const { db, projects, owner } = setup();
    projects.createProject(owner.id, buildProject("p1"));
    projects.deleteProject("p1");

    expect(projects.getProjectById("p1")).toBeNull();
    const segmentCount = db.prepare("SELECT COUNT(*) as c FROM segments WHERE project_id = ?").get("p1") as {
      c: number;
    };
    expect(segmentCount.c).toBe(0);
  });

  it("handles a project with a null transcript and null timeline", () => {
    const { projects, owner } = setup();
    const project: Project = { ...buildProject("p1"), transcript: null, timeline: null };
    projects.createProject(owner.id, project);
    expect(projects.getProjectById("p1")).toEqual(project);
  });

  it("handles a project with zero segments", () => {
    const { projects, owner } = setup();
    const project: Project = { ...buildProject("p1"), segments: [] };
    projects.createProject(owner.id, project);
    expect(projects.getProjectById("p1")?.segments).toEqual([]);
  });

  it("preserves segment order across a round trip", () => {
    const { projects, owner } = setup();
    const project = buildProject("p1");
    projects.createProject(owner.id, project);
    const loaded = projects.getProjectById("p1")!;
    expect(loaded.segments.map((s) => s.id)).toEqual(project.segments.map((s) => s.id));
  });
});

describe("updateProject vs. the job queue", () => {
  /**
   * jobs.project_id is ON DELETE CASCADE, so an update implemented as
   * "delete the project row, insert it again" silently takes the
   * project's whole job queue with it — including the job whose own
   * handler is doing the updating, which then polls as 404 "Job
   * introuvable." for the client watching it.
   */
  it("keeps the project's jobs when the project is updated", () => {
    const { db, projects, owner } = setup();
    const project = buildProject("projet-jobs");
    projects.createProject(owner.id, project);
    const jobs = new SqliteJobRepository(db);
    const job = jobs.createJob({
      id: "job-survivant",
      projectId: project.id,
      kind: "download",
      payload: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      now: "2026-01-01T00:00:00.000Z",
    });

    projects.updateProject(project.id, { ...project, title: "Titre modifié" });

    expect(jobs.getJobById(job.job.id)).not.toBeNull();
    expect(jobs.getJobOwnerId(job.job.id)).toBe(owner.id);
    expect(projects.getProjectById(project.id)?.title).toBe("Titre modifié");
  });
});

describe("SqliteProjectRepository — plan d'effets du segment", () => {
  const plan = buildRenderPlan("hook-emphasis", { segmentId: "p1-seg-1", segmentDurationSec: 60 });

  function withPlan(renderPlan: Segment["renderPlan"]): Project {
    const project = buildProject("p1");
    return { ...project, segments: project.segments.map((s) => ({ ...s, renderPlan })) };
  }

  it("round-trips a segment's render plan", () => {
    const { projects, owner } = setup();
    projects.createProject(owner.id, withPlan(plan));

    expect(projects.getProjectById("p1")?.segments[0].renderPlan).toEqual(plan);
  });

  it("keeps a segment with no plan at null rather than inventing one", () => {
    const { projects, owner } = setup();
    projects.createProject(owner.id, withPlan(null));

    expect(projects.getProjectById("p1")?.segments[0].renderPlan).toBeNull();
  });

  it("persists a plan the user changed, replacing the previous one", () => {
    const { projects, owner } = setup();
    projects.createProject(owner.id, withPlan(plan));

    const edited = buildRenderPlan("clean-captions", { segmentId: "p1-seg-1", segmentDurationSec: 60 });
    projects.updateProject("p1", withPlan(edited));

    expect(projects.getProjectById("p1")?.segments[0].renderPlan?.templateId).toBe("clean-captions");
  });
});
