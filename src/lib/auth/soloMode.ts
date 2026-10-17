import type { DatabaseSync } from "node:sqlite";
import { SqliteUserRepository, type User } from "./UserRepository";

/** Email of the account solo mode creates when it has no existing one to adopt. */
export const DEFAULT_SOLO_EMAIL = "solo@peakcut.local";

/**
 * Solo mode: a deployment used by one person, where signing in would be
 * pure friction. Every request is resolved as the same single account —
 * no session cookie, no Google sign-in, no 401 — so /login, the Google
 * button and the "un compte est nécessaire" dialog never appear (the UI
 * derives all of that from /api/auth/me, which goes through the same
 * resolution).
 *
 * Off unless the server is started with PEAKCUT_SOLO_USER=1 — any other
 * value (unset, "true", "0"…) keeps normal authentication in place. Being
 * an explicit opt-in matters: this is the one switch that makes anyone
 * able to reach the port the owner of every project, so it must never be
 * something a deployment can end up with by accident.
 *
 * Server-only, read per request, never exposed through NEXT_PUBLIC_.
 */
export function isSoloModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEAKCUT_SOLO_USER === "1";
}

/**
 * Accounts that a real person could own — every user row except the
 * ephemeral ones the public trial creates for anonymous visitors. Solo
 * mode must never adopt a trial actor: that row is deleted when the trial
 * expires, which would take the operator's own projects with it.
 */
function listAdoptableUserIds(db: DatabaseSync, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM users
         WHERE id NOT IN (SELECT user_id FROM trial_actors)
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

/**
 * The account every request is resolved as in solo mode, in this order:
 *
 *  1. PEAKCUT_SOLO_USER_EMAIL when set — found by email, created if absent;
 *  2. otherwise the single pre-existing account, when there is exactly one
 *     (so an app that was already used with a login keeps its projects —
 *     they are owned by that user id, and ownership checks still run);
 *  3. otherwise DEFAULT_SOLO_EMAIL, created on first use.
 *
 * Case 3 also covers "several accounts exist": picking one of them by
 * guesswork would silently hand their projects over, so solo mode starts
 * from its own empty account instead, and PEAKCUT_SOLO_USER_EMAIL is how
 * you name the one you actually want.
 */
export function resolveSoloUser(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): User {
  const users = new SqliteUserRepository(db);

  const configuredEmail = env.PEAKCUT_SOLO_USER_EMAIL?.trim();
  if (configuredEmail) return users.findOrCreateSoloUser(configuredEmail);

  const adoptable = listAdoptableUserIds(db, 2);
  if (adoptable.length === 1) {
    const only = users.findById(adoptable[0]);
    if (only) return only;
  }

  return users.findOrCreateSoloUser(DEFAULT_SOLO_EMAIL);
}
