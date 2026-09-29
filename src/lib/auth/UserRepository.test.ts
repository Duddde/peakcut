// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { EmailAlreadyRegisteredError, SqliteUserRepository } from "./UserRepository";

function freshRepo(): SqliteUserRepository {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return new SqliteUserRepository(db);
}

describe("SqliteUserRepository", () => {
  it("creates a user and finds it by id", () => {
    const repo = freshRepo();
    const user = repo.createUser("alice@example.com", "hashed:value");
    expect(user.email).toBe("alice@example.com");
    expect(repo.findById(user.id)).toEqual(user);
  });

  it("finds a user by email including the password hash", () => {
    const repo = freshRepo();
    repo.createUser("bob@example.com", "hashed:bob");
    const found = repo.findByEmail("bob@example.com");
    expect(found?.passwordHash).toBe("hashed:bob");
  });

  it("normalizes email case and whitespace", () => {
    const repo = freshRepo();
    repo.createUser("  Carol@Example.com  ", "hash");
    expect(repo.findByEmail("carol@example.com")).not.toBeNull();
  });

  it("throws EmailAlreadyRegisteredError for a duplicate email", () => {
    const repo = freshRepo();
    repo.createUser("dupe@example.com", "hash1");
    expect(() => repo.createUser("dupe@example.com", "hash2")).toThrow(EmailAlreadyRegisteredError);
  });

  it("returns null for an unknown id or email", () => {
    const repo = freshRepo();
    expect(repo.findById("nonexistent")).toBeNull();
    expect(repo.findByEmail("nobody@example.com")).toBeNull();
  });

  it("never exposes the password hash from findById", () => {
    const repo = freshRepo();
    const user = repo.createUser("eve@example.com", "hash");
    const found = repo.findById(user.id) as unknown as Record<string, unknown>;
    expect(found.passwordHash).toBeUndefined();
  });

  describe("Google OAuth", () => {
    it("findOrCreateGoogleUser creates a new user on first sign-in", () => {
      const repo = freshRepo();
      const user = repo.findOrCreateGoogleUser("newperson@example.com", "google-sub-1");
      expect(user.email).toBe("newperson@example.com");
      expect(repo.findByGoogleId("google-sub-1")?.id).toBe(user.id);
    });

    it("findOrCreateGoogleUser returns the same user on a repeat sign-in with the same google id", () => {
      const repo = freshRepo();
      const first = repo.findOrCreateGoogleUser("person@example.com", "google-sub-2");
      const second = repo.findOrCreateGoogleUser("person@example.com", "google-sub-2");
      expect(second.id).toBe(first.id);
    });

    it("findOrCreateGoogleUser links a google id to an existing account matched by email", () => {
      const repo = freshRepo();
      const existing = repo.createUser("legacy@example.com", "some-password-hash");
      const linked = repo.findOrCreateGoogleUser("legacy@example.com", "google-sub-3");
      expect(linked.id).toBe(existing.id);
      expect(repo.findByGoogleId("google-sub-3")?.id).toBe(existing.id);
    });

    it("creates an OAuth user with no password hash", () => {
      const repo = freshRepo();
      const user = repo.findOrCreateGoogleUser("oauthonly@example.com", "google-sub-4");
      const found = repo.findByEmail(user.email);
      expect(found?.passwordHash).toBeNull();
    });

    it("findByGoogleId returns null for an unknown google id", () => {
      const repo = freshRepo();
      expect(repo.findByGoogleId("nonexistent-sub")).toBeNull();
    });

    it("normalizes email the same way for Google sign-in as for password signup", () => {
      const repo = freshRepo();
      repo.findOrCreateGoogleUser("  Mixed@Example.com  ", "google-sub-5");
      expect(repo.findByEmail("mixed@example.com")).not.toBeNull();
    });
  });
});
