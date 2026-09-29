import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_TTL_MS } from "@/lib/auth/sessionCookie";
import { setSessionCookie } from "@/lib/auth/sessionCookieResponse";

// A precomputed, valid-format hash of a fixed dummy value. When the email
// isn't found, verifyPassword still runs a real scrypt derivation against
// this instead of short-circuiting — so a timing side-channel can't be
// used to tell "wrong password" apart from "no such account".
const DUMMY_HASH = hashPassword("peakcut-dummy-password-for-timing-only");

const GENERIC_INVALID_CREDENTIALS_ERROR = "Identifiants invalides.";

export function createLoginHandler(injectedDeps?: AppDeps) {
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
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return NextResponse.json(
        { ok: false, error: "Les champs 'email' et 'password' sont requis." },
        { status: 400 }
      );
    }

    const users = new SqliteUserRepository(deps.db);
    const found = users.findByEmail(body.email);
    const passwordOk = verifyPassword(body.password, found?.passwordHash ?? DUMMY_HASH);

    if (!found || !passwordOk) {
      return NextResponse.json({ ok: false, error: GENERIC_INVALID_CREDENTIALS_ERROR }, { status: 401 });
    }

    const sessions = new SqliteSessionRepository(deps.db);
    const session = sessions.createSession(found.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());

    const response = NextResponse.json({ ok: true, user: { id: found.id, email: found.email } });
    setSessionCookie(response, session.id, deps.authSecret);
    return response;
  };
}

export const POST = createLoginHandler();
