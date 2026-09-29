import type { NextRequest } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { SESSION_COOKIE_NAME, verifySignedSessionId } from "./sessionCookie";
import { SqliteSessionRepository } from "./SessionRepository";
import { SqliteUserRepository, type User } from "./UserRepository";

/**
 * Resolves the authenticated user (if any) from a request's session
 * cookie: verifies the HMAC signature, looks up the session, checks
 * expiration (deleting it if expired), then loads the user. Returns null
 * for any failure mode rather than throwing — callers protecting a route
 * should treat null as "unauthenticated" and respond 401.
 */
export function getAuthenticatedUserFromRequest(request: NextRequest, deps: AppDeps): User | null {
  const cookieValue = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookieValue) return null;

  const sessionId = verifySignedSessionId(cookieValue, deps.authSecret);
  if (!sessionId) return null;

  const sessions = new SqliteSessionRepository(deps.db);
  const session = sessions.findSession(sessionId);
  if (!session) return null;

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sessions.deleteSession(sessionId);
    return null;
  }

  const users = new SqliteUserRepository(deps.db);
  return users.findById(session.userId);
}
