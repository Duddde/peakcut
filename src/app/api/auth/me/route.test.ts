// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createMeHandler } from "./route";
import { createTestAppDeps } from "../../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest("http://localhost/api/auth/me", { headers });
}

describe("GET /api/auth/me", () => {
  it("returns authenticated: true and the current user for a valid session", async () => {
    const deps = createTestAppDeps();
    const user = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    const session = new SqliteSessionRepository(deps.db).createSession(
      user.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    const GET = createMeHandler(deps);
    const res = await GET(requestWithCookie(signSessionId(session.id, deps.authSecret)));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.authenticated).toBe(true);
    expect(json.user.email).toBe("alice@example.com");
  });

  it("returns 200 with authenticated: false (not a 401 error) without a session cookie", async () => {
    const GET = createMeHandler(createTestAppDeps());
    const res = await GET(requestWithCookie(undefined));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.authenticated).toBe(false);
    expect(json.user).toBeUndefined();
  });

  it("returns authenticated: false for an expired session", async () => {
    const deps = createTestAppDeps();
    const user = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    const session = new SqliteSessionRepository(deps.db).createSession(
      user.id,
      new Date(Date.now() - 1000).toISOString()
    );
    const GET = createMeHandler(deps);
    const res = await GET(requestWithCookie(signSessionId(session.id, deps.authSecret)));
    const json = await res.json();
    expect(json.authenticated).toBe(false);
  });

  it("returns authenticated: false for a garbage cookie value, without throwing", async () => {
    const GET = createMeHandler(createTestAppDeps());
    const res = await GET(requestWithCookie("not-a-valid-signed-cookie"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authenticated).toBe(false);
  });

  it("never leaks the password hash or any other secret-shaped field", async () => {
    const deps = createTestAppDeps();
    const user = new SqliteUserRepository(deps.db).createUser("alice@example.com", "supersecrethash");
    const session = new SqliteSessionRepository(deps.db).createSession(
      user.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    const GET = createMeHandler(deps);
    const res = await GET(requestWithCookie(signSessionId(session.id, deps.authSecret)));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("supersecrethash");
    expect(text.toLowerCase()).not.toContain("passwordhash");
  });
});
