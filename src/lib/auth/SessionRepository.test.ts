// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "./UserRepository";
import { SqliteSessionRepository } from "./SessionRepository";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const users = new SqliteUserRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const user = users.createUser("alice@example.com", "hash");
  return { db, sessions, user };
}

describe("SqliteSessionRepository", () => {
  it("creates a session and finds it by id", () => {
    const { sessions, user } = setup();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const session = sessions.createSession(user.id, expiresAt);
    expect(session.userId).toBe(user.id);
    expect(sessions.findSession(session.id)).toEqual(session);
  });

  it("returns null for an unknown session id", () => {
    const { sessions } = setup();
    expect(sessions.findSession("nonexistent")).toBeNull();
  });

  it("deletes a session (logout)", () => {
    const { sessions, user } = setup();
    const session = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    sessions.deleteSession(session.id);
    expect(sessions.findSession(session.id)).toBeNull();
  });

  it("deleting a nonexistent session does not throw", () => {
    const { sessions } = setup();
    expect(() => sessions.deleteSession("nonexistent")).not.toThrow();
  });

  it("cascades deletion when the owning user is deleted", () => {
    const { db, sessions, user } = setup();
    const session = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    expect(sessions.findSession(session.id)).toBeNull();
  });

  it("deleteExpiredSessions removes only sessions past the given time", () => {
    const { sessions, user } = setup();
    const past = sessions.createSession(user.id, new Date(Date.now() - 1000).toISOString());
    const future = sessions.createSession(user.id, new Date(Date.now() + 60_000).toISOString());
    const removed = sessions.deleteExpiredSessions(new Date().toISOString());
    expect(removed).toBe(1);
    expect(sessions.findSession(past.id)).toBeNull();
    expect(sessions.findSession(future.id)).not.toBeNull();
  });

  it("generates unique, hard-to-guess session ids", () => {
    const { sessions, user } = setup();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const a = sessions.createSession(user.id, expiresAt);
    const b = sessions.createSession(user.id, expiresAt);
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(20);
  });
});
