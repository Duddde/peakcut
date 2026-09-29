// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createProjectDeleteHandler, createProjectGetHandler, createProjectPatchHandler } from "./route";
import { createProjectsCreateHandler } from "../route";
import { createTestAppDeps } from "../../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import type { AppDeps } from "@/lib/appDeps";

function makeAuthedUserAndCookie(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  return { user, cookie: signSessionId(session.id, deps.authSecret) };
}

function requestWithCookie(url: string, cookie?: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  return new NextRequest(url, { ...init, signal: undefined, headers });
}

async function createProjectFor(deps: AppDeps, cookie: string, title = "Projet") {
  const POST = createProjectsCreateHandler(deps);
  const res = await POST(
    requestWithCookie("http://localhost/api/projects", cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
  );
  const json = await res.json();
  return json.project as { id: string };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/projects/[id]", () => {
  it("returns the project for its owner", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const project = await createProjectFor(deps, cookie);

    const GET = createProjectGetHandler(deps);
    const res = await GET(requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie), ctx(project.id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project.id).toBe(project.id);
  });

  it("returns 401 without authentication", async () => {
    const deps = createTestAppDeps();
    const GET = createProjectGetHandler(deps);
    const res = await GET(requestWithCookie("http://localhost/api/projects/x"), ctx("x"));
    expect(res.status).toBe(401);
  });

  it("returns 404 (not 403) for another user's project — no existence leak", async () => {
    const deps = createTestAppDeps();
    const alice = makeAuthedUserAndCookie(deps, "alice@example.com");
    const bob = makeAuthedUserAndCookie(deps, "bob@example.com");
    const aliceProject = await createProjectFor(deps, alice.cookie);

    const GET = createProjectGetHandler(deps);
    const res = await GET(
      requestWithCookie(`http://localhost/api/projects/${aliceProject.id}`, bob.cookie),
      ctx(aliceProject.id)
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent project", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const GET = createProjectGetHandler(deps);
    const res = await GET(requestWithCookie("http://localhost/api/projects/nope", cookie), ctx("nope"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/[id]", () => {
  it("updates the title for the owner", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const project = await createProjectFor(deps, cookie);

    const PATCH = createProjectPatchHandler(deps);
    const res = await PATCH(
      requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Titre modifié" }),
      }),
      ctx(project.id)
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project.title).toBe("Titre modifié");

    const GET = createProjectGetHandler(deps);
    const reloaded = await (
      await GET(requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie), ctx(project.id))
    ).json();
    expect(reloaded.project.title).toBe("Titre modifié");
  });

  it("refuses to update another user's project with 404", async () => {
    const deps = createTestAppDeps();
    const alice = makeAuthedUserAndCookie(deps, "alice@example.com");
    const bob = makeAuthedUserAndCookie(deps, "bob@example.com");
    const aliceProject = await createProjectFor(deps, alice.cookie);

    const PATCH = createProjectPatchHandler(deps);
    const res = await PATCH(
      requestWithCookie(`http://localhost/api/projects/${aliceProject.id}`, bob.cookie, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hacked" }),
      }),
      ctx(aliceProject.id)
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid patch body", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const project = await createProjectFor(deps, cookie);

    const PATCH = createProjectPatchHandler(deps);
    const res = await PATCH(
      requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "not-a-real-status" }),
      }),
      ctx(project.id)
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 without authentication", async () => {
    const deps = createTestAppDeps();
    const PATCH = createProjectPatchHandler(deps);
    const res = await PATCH(
      requestWithCookie("http://localhost/api/projects/x", undefined, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
      ctx("x")
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/projects/[id]", () => {
  it("deletes the project for its owner", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const project = await createProjectFor(deps, cookie);

    const DELETE = createProjectDeleteHandler(deps);
    const res = await DELETE(requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie), ctx(project.id));
    expect(res.status).toBe(200);

    const GET = createProjectGetHandler(deps);
    const getRes = await GET(
      requestWithCookie(`http://localhost/api/projects/${project.id}`, cookie),
      ctx(project.id)
    );
    expect(getRes.status).toBe(404);
  });

  it("refuses to delete another user's project with 404, leaving it intact", async () => {
    const deps = createTestAppDeps();
    const alice = makeAuthedUserAndCookie(deps, "alice@example.com");
    const bob = makeAuthedUserAndCookie(deps, "bob@example.com");
    const aliceProject = await createProjectFor(deps, alice.cookie);

    const DELETE = createProjectDeleteHandler(deps);
    const res = await DELETE(
      requestWithCookie(`http://localhost/api/projects/${aliceProject.id}`, bob.cookie),
      ctx(aliceProject.id)
    );
    expect(res.status).toBe(404);

    const GET = createProjectGetHandler(deps);
    const stillThere = await GET(
      requestWithCookie(`http://localhost/api/projects/${aliceProject.id}`, alice.cookie),
      ctx(aliceProject.id)
    );
    expect(stillThere.status).toBe(200);
  });

  it("returns 401 without authentication", async () => {
    const deps = createTestAppDeps();
    const DELETE = createProjectDeleteHandler(deps);
    const res = await DELETE(requestWithCookie("http://localhost/api/projects/x"), ctx("x"));
    expect(res.status).toBe(401);
  });
});
