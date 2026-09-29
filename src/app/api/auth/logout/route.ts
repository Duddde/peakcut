import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, verifySignedSessionId } from "@/lib/auth/sessionCookie";
import { clearSessionCookie } from "@/lib/auth/sessionCookieResponse";

export function createLogoutHandler(injectedDeps?: AppDeps) {
  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const cookieValue = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (cookieValue) {
      const sessionId = verifySignedSessionId(cookieValue, deps.authSecret);
      if (sessionId) {
        new SqliteSessionRepository(deps.db).deleteSession(sessionId);
      }
    }

    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  };
}

export const POST = createLogoutHandler();
