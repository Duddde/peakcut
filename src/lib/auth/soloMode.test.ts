import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { hashPassword } from "@/lib/auth/passwords";
import { SqliteTrialActorRepository } from "@/lib/publicTrial/TrialActorRepository";
import { DEFAULT_SOLO_EMAIL, isSoloModeEnabled, resolveSoloUser } from "@/lib/auth/soloMode";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("isSoloModeEnabled", () => {
  it("is off unless PEAKCUT_SOLO_USER is exactly 1", () => {
    expect(isSoloModeEnabled(env({}))).toBe(false);
    expect(isSoloModeEnabled(env({ PEAKCUT_SOLO_USER: "true" }))).toBe(false);
    expect(isSoloModeEnabled(env({ PEAKCUT_SOLO_USER: "0" }))).toBe(false);
    expect(isSoloModeEnabled(env({ PEAKCUT_SOLO_USER: "" }))).toBe(false);
    expect(isSoloModeEnabled(env({ PEAKCUT_SOLO_USER: "1" }))).toBe(true);
  });
});

describe("resolveSoloUser", () => {
  it("adopts the single pre-existing account, so projects already owned stay reachable", () => {
    const db = freshDb();
    const existing = new SqliteUserRepository(db).createUser("dev@local.test", hashPassword("motdepasse-de-test"));

    const solo = resolveSoloUser(db, env({}));

    expect(solo.id).toBe(existing.id);
    expect(solo.email).toBe("dev@local.test");
  });

  it("creates a passwordless account when the database has none", () => {
    const db = freshDb();

    const solo = resolveSoloUser(db, env({}));

    expect(solo.email).toBe(DEFAULT_SOLO_EMAIL);
    const row = db.prepare("SELECT password_hash, google_id FROM users WHERE id = ?").get(solo.id);
    expect(row).toMatchObject({ password_hash: null, google_id: null });
  });

  it("is stable across calls instead of creating a new account each time", () => {
    const db = freshDb();

    expect(resolveSoloUser(db, env({})).id).toBe(resolveSoloUser(db, env({})).id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toMatchObject({ n: 1 });
  });

  it("honours PEAKCUT_SOLO_USER_EMAIL over the account that happens to exist", () => {
    const db = freshDb();
    const other = new SqliteUserRepository(db).createUser("dev@local.test", hashPassword("motdepasse-de-test"));

    const solo = resolveSoloUser(db, env({ PEAKCUT_SOLO_USER_EMAIL: "Moi@Exemple.test" }));

    expect(solo.id).not.toBe(other.id);
    expect(solo.email).toBe("moi@exemple.test");
  });

  it("never adopts a public-trial actor, whose row is deleted when the trial expires", () => {
    const db = freshDb();
    const trialActor = new SqliteTrialActorRepository(db).create({
      nowMs: Date.now(),
      ttlMs: 60_000,
      maxActive: 5,
    });

    const solo = resolveSoloUser(db, env({}));

    expect(solo.id).not.toBe(trialActor.userId);
    expect(solo.email).toBe(DEFAULT_SOLO_EMAIL);
  });

  it("starts from its own account rather than guessing between several existing ones", () => {
    const db = freshDb();
    const users = new SqliteUserRepository(db);
    const first = users.createUser("un@local.test", hashPassword("motdepasse-de-test"));
    const second = users.createUser("deux@local.test", hashPassword("motdepasse-de-test"));

    const solo = resolveSoloUser(db, env({}));

    expect(solo.id).not.toBe(first.id);
    expect(solo.id).not.toBe(second.id);
    expect(solo.email).toBe(DEFAULT_SOLO_EMAIL);
  });
});
