// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getAppliedMigrationVersions, MIGRATIONS, runMigrations } from "./migrations";

function freshDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

const EXPECTED_TABLES = [
  "users",
  "sessions",
  "projects",
  "sources",
  "transcripts",
  "workflows",
  "segments",
  "export_jobs",
];

describe("runMigrations", () => {
  it("creates every expected table", () => {
    const db = freshDb();
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("records applied migration versions", () => {
    const db = freshDb();
    runMigrations(db);
    expect(getAppliedMigrationVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it("is idempotent: running twice does not error or duplicate records", () => {
    const db = freshDb();
    runMigrations(db);
    runMigrations(db);
    expect(getAppliedMigrationVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it("enforces foreign keys once migrated (via connection.ts's PRAGMA, tested at the schema level here with an explicit pragma)", () => {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    expect(() =>
      db
        .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("s1", "nonexistent-user", "now", "later")
    ).toThrow();
  });

  it("rolls back a failing migration without recording it as applied", () => {
    const db = freshDb();
    expect(() =>
      runMigrations(db, [{ version: 99, name: "broken", sql: "CREATE TABLE this is not valid sql;" }])
    ).toThrow();
    expect(getAppliedMigrationVersions(db)).toEqual([]);
  });

  it("only applies migrations not already recorded, leaving existing data intact", () => {
    const db = freshDb();
    runMigrations(db, [MIGRATIONS[0]]);
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      "u1",
      "a@example.com",
      "hash",
      "now"
    );
    // Re-running the full migration set must not touch existing data or re-run version 1.
    runMigrations(db, MIGRATIONS);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get("u1");
    expect(user).toBeDefined();
  });

  it("migration 2 (add_google_auth) makes password_hash nullable and adds a unique google_id", () => {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);

    expect(() =>
      db
        .prepare("INSERT INTO users (id, email, password_hash, google_id, created_at) VALUES (?, ?, NULL, ?, ?)")
        .run("u1", "oauth@example.com", "google-sub-123", "now")
    ).not.toThrow();

    expect(() =>
      db
        .prepare("INSERT INTO users (id, email, password_hash, google_id, created_at) VALUES (?, ?, NULL, ?, ?)")
        .run("u2", "other@example.com", "google-sub-123", "now")
    ).toThrow();
  });

  it("migration 2 preserves existing users and their sessions from before the rebuild", () => {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db, [MIGRATIONS[0]]);
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      "u1",
      "legacy@example.com",
      "hash",
      "now"
    );
    db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      "s1",
      "u1",
      "now",
      "later"
    );

    runMigrations(db, MIGRATIONS);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get("u1") as { password_hash: string };
    expect(user.password_hash).toBe("hash");
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1");
    expect(session).toBeDefined();
  });
});
