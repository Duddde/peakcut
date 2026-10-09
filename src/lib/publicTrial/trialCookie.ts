import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

export const TRIAL_COOKIE_NAME = "peakcut_trial";

/**
 * Domain-separation prefix mixed into the HMAC: the trial cookie is signed
 * with the same PEAKCUT_AUTH_SECRET as the account session cookie, so
 * without it a valid `peakcut_session` signature could be replayed as a
 * trial cookie (or vice versa).
 */
const SIGNING_CONTEXT = "peakcut-public-trial:v1:";

export interface TrialCookiePayload {
  /** The trial actor's backing users.id. */
  actorId: string;
  /** Hard expiry, in epoch milliseconds — also enforced server-side against trial_actors.expires_at. */
  expiresAtMs: number;
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(SIGNING_CONTEXT + body).digest("hex");
}

/** Cookie value: `${actorId}.${expiresAtMs}.${hmacHex}`. */
export function signTrialCookie(payload: TrialCookiePayload, secret: string): string {
  const body = `${payload.actorId}.${payload.expiresAtMs}`;
  return `${body}.${mac(body, secret)}`;
}

/**
 * Returns the payload only when the signature is valid AND the embedded
 * expiry is still in the future. Never throws: anything malformed is null.
 */
export function verifyTrialCookie(value: string | undefined, secret: string, nowMs = Date.now()): TrialCookiePayload | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [actorId, expiresRaw, providedMac] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(actorId) || !/^\d{1,16}$/.test(expiresRaw) || !/^[0-9a-f]{64}$/i.test(providedMac)) {
    return null;
  }

  const expected = Buffer.from(mac(`${actorId}.${expiresRaw}`, secret), "hex");
  const provided = Buffer.from(providedMac, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  return { actorId, expiresAtMs };
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function setTrialCookie(response: NextResponse, payload: TrialCookiePayload, secret: string, nowMs = Date.now()): void {
  const maxAgeSeconds = Math.max(0, Math.floor((payload.expiresAtMs - nowMs) / 1000));
  response.cookies.set(TRIAL_COOKIE_NAME, signTrialCookie(payload, secret), cookieOptions(maxAgeSeconds));
}

export function clearTrialCookie(response: NextResponse): void {
  response.cookies.set(TRIAL_COOKIE_NAME, "", cookieOptions(0));
}
