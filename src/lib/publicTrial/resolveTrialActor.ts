import type { NextRequest } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteUserRepository, type User } from "@/lib/auth/UserRepository";
import { isPublicTrialEnabled } from "./config";
import { TRIAL_COOKIE_NAME, verifyTrialCookie } from "./trialCookie";
import { SqliteTrialActorRepository } from "./TrialActorRepository";

export interface ResolvedTrialActor {
  user: User;
  expiresAt: string;
}

/**
 * Resolves the anonymous trial actor carried by the request's signed trial
 * cookie, or null. Every condition is required:
 *  - PEAKCUT_PUBLIC_TRIAL=1 (flag off ⇒ the cookie is ignored outright);
 *  - a valid HMAC signature and an unexpired cookie;
 *  - a trial_actors row that still exists and has not expired server-side
 *    (the DB expiry wins over the cookie's — a cleaned-up or shortened
 *    trial can't be revived by replaying an old cookie).
 */
export function resolveTrialActorFromRequest(
  request: NextRequest,
  deps: AppDeps,
  options: { env?: NodeJS.ProcessEnv; nowMs?: number } = {}
): ResolvedTrialActor | null {
  if (!isPublicTrialEnabled(options.env)) return null;
  const nowMs = options.nowMs ?? Date.now();

  const payload = verifyTrialCookie(request.cookies.get(TRIAL_COOKIE_NAME)?.value, deps.authSecret, nowMs);
  if (!payload) return null;

  const actor = new SqliteTrialActorRepository(deps.db).findActive(payload.actorId, nowMs);
  if (!actor) return null;

  const user = new SqliteUserRepository(deps.db).findById(actor.userId);
  if (!user) return null;
  return { user, expiresAt: actor.expiresAt };
}
