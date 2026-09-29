// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "./UserRepository";
import { SqliteSessionRepository } from "./SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "./sessionCookie";
import { getAuthenticatedUserFromRequest } from "./getAuthenticatedUserFromRequest";

const AUTH_SECRET = "a".repeat(32);

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const user = users.createUser("alice@example.com", "hash");
  return { db, users, sessions, user };
}

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest("http://localhost/api/projects", { headers });
}

describe("getAuthenticatedUserFromRequest", () => {
  it("returns the user for a valid, signed, unexpired session cookie", () => {
    const { db, sessions, user } = setup();
    const session = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    const cookie = signSessionId(session.id, AUTH_SECRET);
    const result = getAuthenticatedUserFromRequest(requestWithCookie(cookie), { db, authSecret: AUTH_SECRET });
    expect(result).toEqual(user);
  });

  it("returns null when there is no cookie at all", () => {
    const { db } = setup();
    const result = getAuthenticatedUserFromRequest(requestWithCookie(undefined), { db, authSecret: AUTH_SECRET });
    expect(result).toBeNull();
  });

  it("returns null for a cookie signed with the wrong secret", () => {
    const { db, sessions, user } = setup();
    const session = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    const cookie = signSessionId(session.id, "b".repeat(32));
    const result = getAuthenticatedUserFromRequest(requestWithCookie(cookie), { db, authSecret: AUTH_SECRET });
    expect(result).toBeNull();
  });

  it("returns null and deletes the session for an expired session", () => {
    const { db, sessions, user } = setup();
    const session = sessions.createSession(user.id, new Date(Date.now() - 1000).toISOString());
    const cookie = signSessionId(session.id, AUTH_SECRET);
    const result = getAuthenticatedUserFromRequest(requestWithCookie(cookie), { db, authSecret: AUTH_SECRET });
    expect(result).toBeNull();
    expect(sessions.findSession(session.id)).toBeNull();
  });

  it("returns null for a well-signed but nonexistent session id", () => {
    const { db } = setup();
    const cookie = signSessionId("00000000-0000-0000-0000-000000000000", AUTH_SECRET);
    const result = getAuthenticatedUserFromRequest(requestWithCookie(cookie), { db, authSecret: AUTH_SECRET });
    expect(result).toBeNull();
  });

  it("returns null for a garbage cookie value", () => {
    const { db } = setup();
    const result = getAuthenticatedUserFromRequest(requestWithCookie("not-a-valid-cookie"), {
      db,
      authSecret: AUTH_SECRET,
    });
    expect(result).toBeNull();
  });
});
