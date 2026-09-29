// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createProjectsCreateHandler, createProjectsListHandler } from "./route";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
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

describe("GET /api/projects", () => {
  it("returns 401 without authentication", async () => {
    const GET = createProjectsListHandler(createTestAppDeps());
    const res = await GET(requestWithCookie("http://localhost/api/projects"));
    expect(res.status).toBe(401);
  });

  it("lists only the authenticated user's own projects", async () => {
    const deps = createTestAppDeps();
    const alice = makeAuthedUserAndCookie(deps, "alice@example.com");
    const bob = makeAuthedUserAndCookie(deps, "bob@example.com");

    const createProject = createProjectsCreateHandler(deps);
    await createProject(
      requestWithCookie("http://localhost/api/projects", alice.cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Projet Alice" }),
      })
    );
    await createProject(
      requestWithCookie("http://localhost/api/projects", bob.cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Projet Bob" }),
      })
    );

    const GET = createProjectsListHandler(deps);
    const aliceList = await (await GET(requestWithCookie("http://localhost/api/projects", alice.cookie))).json();
    expect(aliceList.projects).toHaveLength(1);
    expect(aliceList.projects[0].title).toBe("Projet Alice");
  });
});

describe("POST /api/projects", () => {
  it("returns 401 without authentication", async () => {
    const POST = createProjectsCreateHandler(createTestAppDeps());
    const res = await POST(
      requestWithCookie("http://localhost/api/projects", undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(401);
  });

  it("creates a project owned by the authenticated user, with a safe default source and workflow", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const POST = createProjectsCreateHandler(deps);
    const res = await POST(
      requestWithCookie("http://localhost/api/projects", cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Mon projet" }),
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.project.title).toBe("Mon projet");
    expect(json.project.segments).toEqual([]);
    expect(json.project.source.localFilePath).toBeUndefined();
    expect(json.project.workflow.phase).toBe("analysis_preview");
    expect(json.project.workflow.rights.confirmed).toBe(false);
  });

  it("defaults the title when none is provided", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const POST = createProjectsCreateHandler(deps);
    const res = await POST(
      requestWithCookie("http://localhost/api/projects", cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const json = await res.json();
    expect(typeof json.project.title).toBe("string");
    expect(json.project.title.length).toBeGreaterThan(0);
  });
});
