// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { CHAIN_PAYLOAD_KEY } from "@/lib/jobs/chain";
import type { Project } from "@/lib/domain/types";
import { createJobsCreateHandler } from "./route";

const NOW = "2026-01-01T00:00:00.000Z";

function signedInCookies(deps: AppDeps, email: string): Record<string, string> {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(user.id, new Date(Date.now() + 3_600_000).toISOString());
  return { [SESSION_COOKIE_NAME]: signSessionId(session.id, deps.authSecret) };
}

function seedProject(deps: AppDeps, ownerEmail = "owner@example.com"): { projectId: string; cookies: Record<string, string> } {
  const users = new SqliteUserRepository(deps.db);
  const user = users.findByEmail(ownerEmail) ?? users.createUser(ownerEmail, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(user.id, new Date(Date.now() + 3_600_000).toISOString());
  const project: Project = {
    id: "proj-1",
    title: "Projet",
    createdAt: NOW,
    updatedAt: NOW,
    status: "draft",
    source: {
      id: "src-1",
      type: "youtube",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Une vidéo",
      durationSec: 600,
      originTimestamp: NOW,
      confidence: 0.9,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
  new SqliteProjectRepository(deps.db).createProject(user.id, project);
  return { projectId: project.id, cookies: { [SESSION_COOKIE_NAME]: signSessionId(session.id, deps.authSecret) } };
}

function post(body: unknown, cookies: Record<string, string>) {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(
    "cookie",
    Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
  );
  return new NextRequest("http://localhost/api/jobs", { method: "POST", headers, body: JSON.stringify(body) });
}

interface ChainStepShape {
  kind: string;
  payload: Record<string, unknown>;
}

function chainOf(payload: unknown): ChainStepShape[] {
  return ((payload as Record<string, unknown>)[CHAIN_PAYLOAD_KEY] ?? []) as ChainStepShape[];
}

describe("POST /api/jobs — enchaînement automatique", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches the remaining pipeline steps to the job it creates", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    const res = await createJobsCreateHandler(deps)(
      post({ projectId, kind: "download", pipeline: { providerId: "openai", trackProvider: "local-subject" } }, cookies)
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    const steps = chainOf(json.job.payload);
    expect(steps.map((s) => s.kind)).toEqual(["transcription", "analysis", "tracking"]);
    expect(steps[0].payload).toEqual({ providerId: "openai" });
    expect(steps[2].payload).toEqual({ provider: "local-subject" });
  });

  it("chains only the remaining steps when starting mid-pipeline", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    const res = await createJobsCreateHandler(deps)(
      post({ projectId, kind: "transcription", payload: { providerId: "openai" }, pipeline: { providerId: "openai" } }, cookies)
    );
    const json = await res.json();

    expect(chainOf(json.job.payload).map((s) => s.kind)).toEqual(["analysis", "tracking"]);
  });

  it("creates an unchained job when no pipeline is requested", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    const res = await createJobsCreateHandler(deps)(post({ projectId, kind: "analysis" }, cookies));
    const json = await res.json();

    expect(chainOf(json.job.payload)).toEqual([]);
  });

  it("refuses a pipeline that would transcribe with no provider, rather than skipping the step", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    const res = await createJobsCreateHandler(deps)(post({ projectId, kind: "download", pipeline: true }, cookies));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/providerId/);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  /**
   * The chain is executed by the worker, which does not come back through
   * this route's ownership and quota checks — so it must never be
   * something a client can hand in.
   */
  it("refuses a client-supplied chain in the payload", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    const res = await createJobsCreateHandler(deps)(
      post(
        { projectId, kind: "analysis", payload: { [CHAIN_PAYLOAD_KEY]: [{ kind: "render", payload: {} }] } },
        cookies
      )
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(new RegExp(CHAIN_PAYLOAD_KEY));
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("rejects a malformed pipeline option instead of guessing", async () => {
    const deps = createTestAppDeps();
    const { projectId, cookies } = seedProject(deps);

    for (const pipeline of [{ providerId: 3 }, { providerId: " " }, { resegment: "oui" }, "openai"]) {
      const res = await createJobsCreateHandler(deps)(post({ projectId, kind: "download", pipeline }, cookies));
      expect(res.status).toBe(400);
    }
  });

  it("requires ownership of the project before anything is chained", async () => {
    const deps = createTestAppDeps();
    seedProject(deps);
    const strangerCookies = signedInCookies(deps, "stranger@example.com");

    const res = await createJobsCreateHandler(deps)(
      post({ projectId: "proj-1", kind: "download", pipeline: { providerId: "openai" } }, strangerCookies)
    );

    expect(res.status).toBe(404);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });
});
