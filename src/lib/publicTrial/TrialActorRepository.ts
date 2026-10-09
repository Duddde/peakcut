import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface TrialActor {
  /** users.id of the backing (password-less, Google-less) user row. */
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Reserved, non-routable (RFC 2606 `.invalid`) domain: no real account can ever be registered under it. */
export const TRIAL_EMAIL_DOMAIN = "public-trial.peakcut.invalid";

export class TrialCapacityError extends Error {
  constructor() {
    super("L'essai public est complet pour le moment. Réessayez dans quelques minutes.");
    this.name = "TrialCapacityError";
  }
}

interface TrialActorRow {
  user_id: string;
  created_at: string;
  expires_at: string;
}

function rowToActor(row: TrialActorRow): TrialActor {
  return { userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
}

/**
 * Anonymous public-trial actors. Each one is a regular `users` row (so every
 * existing owner_id check isolates it from private accounts with no special
 * case) plus a `trial_actors` marker carrying the hard expiry. The backing
 * user has no password_hash and no google_id, so it can never be signed in
 * to through /api/auth/login or Google — only through the signed trial
 * cookie, and only while PEAKCUT_PUBLIC_TRIAL=1.
 */
export class SqliteTrialActorRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Creates an actor, enforcing `maxActive` atomically: the count and the
   * insert run under one BEGIN IMMEDIATE write lock, so two concurrent
   * starts can never both squeeze past the cap.
   */
  create(params: { nowMs: number; ttlMs: number; maxActive: number }): TrialActor {
    const createdAt = new Date(params.nowMs).toISOString();
    const expiresAt = new Date(params.nowMs + params.ttlMs).toISOString();
    const userId = randomUUID();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { active } = this.db
        .prepare("SELECT COUNT(*) AS active FROM trial_actors WHERE expires_at > ?")
        .get(createdAt) as { active: number };
      if (Number(active) >= params.maxActive) {
        throw new TrialCapacityError();
      }
      this.db
        .prepare("INSERT INTO users (id, email, password_hash, google_id, created_at) VALUES (?, ?, NULL, NULL, ?)")
        .run(userId, `trial-${userId}@${TRIAL_EMAIL_DOMAIN}`, createdAt);
      this.db
        .prepare("INSERT INTO trial_actors (user_id, created_at, expires_at) VALUES (?, ?, ?)")
        .run(userId, createdAt, expiresAt);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { userId, createdAt, expiresAt };
  }

  find(userId: string): TrialActor | null {
    const row = this.db.prepare("SELECT * FROM trial_actors WHERE user_id = ?").get(userId) as TrialActorRow | undefined;
    return row ? rowToActor(row) : null;
  }

  /** The actor, only while it has not expired. */
  findActive(userId: string, nowMs: number): TrialActor | null {
    const actor = this.find(userId);
    if (!actor || new Date(actor.expiresAt).getTime() <= nowMs) return null;
    return actor;
  }

  isTrialUser(userId: string): boolean {
    return this.db.prepare("SELECT 1 FROM trial_actors WHERE user_id = ?").get(userId) !== undefined;
  }

  listExpired(nowMs: number): TrialActor[] {
    const rows = this.db
      .prepare("SELECT * FROM trial_actors WHERE expires_at <= ? ORDER BY expires_at ASC")
      .all(new Date(nowMs).toISOString()) as unknown as TrialActorRow[];
    return rows.map(rowToActor);
  }

  /**
   * Deletes the backing user, which cascades to trial_actors, sessions,
   * projects and — through projects — sources, segments, workflows and jobs.
   * Refuses to touch a user that isn't a trial actor, so a bug upstream can
   * never turn this into "delete an arbitrary account".
   */
  delete(userId: string): boolean {
    if (!this.isTrialUser(userId)) return false;
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return Number(result.changes) > 0;
  }
}

/**
 * Trial status of the project's owner: "none" for a private account's
 * project (or a project that doesn't exist), otherwise whether the trial
 * that owns it is still alive. Used by the worker, which must apply trial
 * limits whatever the web server's flag currently says.
 */
export function getProjectTrialStatus(db: DatabaseSync, projectId: string, nowMs: number): "none" | "active" | "expired" {
  const row = db
    .prepare(
      `SELECT t.expires_at AS expires_at
       FROM projects p JOIN trial_actors t ON t.user_id = p.owner_id
       WHERE p.id = ?`
    )
    .get(projectId) as { expires_at: string } | undefined;
  if (!row) return "none";
  return new Date(row.expires_at).getTime() > nowMs ? "active" : "expired";
}
