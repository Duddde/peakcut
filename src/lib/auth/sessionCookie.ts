import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "peakcut_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The session cookie value is `${sessionId}.${hmacHex}` — HMAC-signed with
 * PEAKCUT_AUTH_SECRET. The session id alone is already an unguessable
 * random UUID looked up in the sessions table, but signing means a forged
 * or tampered cookie is rejected before ever touching the database.
 */
export function signSessionId(sessionId: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(sessionId).digest("hex");
  return `${sessionId}.${mac}`;
}

export function verifySignedSessionId(value: string, secret: string): string | null {
  if (!value) return null;
  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  const sessionId = value.slice(0, separatorIndex);
  const providedMac = value.slice(separatorIndex + 1);
  const expectedMac = createHmac("sha256", secret).update(sessionId).digest("hex");

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(providedMac, "hex");
    expectedBuf = Buffer.from(expectedMac, "hex");
  } catch {
    return null;
  }
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }
  return sessionId;
}
