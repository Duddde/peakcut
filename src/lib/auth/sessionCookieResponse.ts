import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, signSessionId } from "./sessionCookie";

/**
 * httpOnly always; `secure` only in production so local http:// dev still
 * works (browsers drop `secure` cookies over plain http); sameSite=lax
 * balances CSRF protection with normal top-level navigation.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function setSessionCookie(response: NextResponse, sessionId: string, authSecret: string): void {
  const value = signSessionId(sessionId, authSecret);
  response.cookies.set(SESSION_COOKIE_NAME, value, cookieOptions(Math.floor(SESSION_TTL_MS / 1000)));
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
}
