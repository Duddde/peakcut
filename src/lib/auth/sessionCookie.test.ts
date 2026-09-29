import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, signSessionId, verifySignedSessionId } from "./sessionCookie";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);

describe("signSessionId / verifySignedSessionId", () => {
  it("round-trips a session id with the correct secret", () => {
    const signed = signSessionId("session-123", SECRET_A);
    expect(verifySignedSessionId(signed, SECRET_A)).toBe("session-123");
  });

  it("rejects a value signed with a different secret", () => {
    const signed = signSessionId("session-123", SECRET_A);
    expect(verifySignedSessionId(signed, SECRET_B)).toBeNull();
  });

  it("rejects a tampered session id even if the signature format looks valid", () => {
    const signed = signSessionId("session-123", SECRET_A);
    const [, mac] = signed.split(".");
    const tampered = `session-999.${mac}`;
    expect(verifySignedSessionId(tampered, SECRET_A)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const signed = signSessionId("session-123", SECRET_A);
    const tampered = signed.slice(0, -1) + (signed.at(-1) === "0" ? "1" : "0");
    expect(verifySignedSessionId(tampered, SECRET_A)).toBeNull();
  });

  it("rejects a malformed value with no separator", () => {
    expect(verifySignedSessionId("not-a-signed-value", SECRET_A)).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(verifySignedSessionId("", SECRET_A)).toBeNull();
  });

  it("exposes a stable, non-generic cookie name", () => {
    expect(SESSION_COOKIE_NAME).toBe("peakcut_session");
  });
});
