// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createLogoutHandler } from "./route";
import { createTestAppDeps } from "../../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers });
}

describe("POST /api/auth/logout", () => {
  it("deletes the session from the database and clears the cookie", async () => {
    const deps = createTestAppDeps();
    const user = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    const sessions = new SqliteSessionRepository(deps.db);
    const session = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    const cookie = signSessionId(session.id, deps.authSecret);

    const POST = createLogoutHandler(deps);
    const res = await POST(requestWithCookie(cookie));

    expect(res.status).toBe(200);
    expect(sessions.findSession(session.id)).toBeNull();
    const clearedCookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(clearedCookie?.value).toBe("");
  });

  it("succeeds even without an existing session cookie", async () => {
    const deps = createTestAppDeps();
    const POST = createLogoutHandler(deps);
    const res = await POST(requestWithCookie(undefined));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("succeeds even with a garbage/invalid cookie value", async () => {
    const deps = createTestAppDeps();
    const POST = createLogoutHandler(deps);
    const res = await POST(requestWithCookie("garbage-not-signed"));
    expect(res.status).toBe(200);
  });
});
