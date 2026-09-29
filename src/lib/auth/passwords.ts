import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing via Node's built-in scrypt (no external native
 * dependency). Stored format: "scrypt:<saltHex>:<hashHex>" — the scheme
 * prefix lets verifyPassword reject anything it doesn't recognize instead
 * of guessing, and lets a future scheme migration coexist safely.
 */

const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== "scrypt") return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
