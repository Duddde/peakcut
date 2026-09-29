import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { validateSignupCredentials } from "@/lib/auth/validateCredentials";
import { hashPassword } from "@/lib/auth/passwords";
import { EmailAlreadyRegisteredError, SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_TTL_MS } from "@/lib/auth/sessionCookie";
import { setSessionCookie } from "@/lib/auth/sessionCookieResponse";

/**
 * Creates a local account (email + scrypt-hashed password) and immediately
 * signs the caller in via a fresh session cookie. Never returns the
 * password or its hash. Requires PEAKCUT_AUTH_SECRET and PEAKCUT_DB_PATH —
 * see resolveRouteDeps for the explicit-config-error behavior when either
 * is missing.
 */
export function createSignupHandler(injectedDeps?: AppDeps) {
  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }
    if (typeof json !== "object" || json === null) {
      return NextResponse.json({ ok: false, error: "Le corps de la requête doit être un objet." }, { status: 400 });
    }
    const body = json as Record<string, unknown>;

    const validation = validateSignupCredentials(body.email, body.password);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }
    const email = (body.email as string).trim();
    const password = body.password as string;

    const users = new SqliteUserRepository(deps.db);
    const passwordHash = hashPassword(password);

    let user;
    try {
      user = users.createUser(email, passwordHash);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return NextResponse.json(
          { ok: false, error: "Un compte existe déjà pour cette adresse email." },
          { status: 409 }
        );
      }
      throw err;
    }

    const sessions = new SqliteSessionRepository(deps.db);
    const session = sessions.createSession(user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());

    const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } }, { status: 201 });
    setSessionCookie(response, session.id, deps.authSecret);
    return response;
  };
}

export const POST = createSignupHandler();
