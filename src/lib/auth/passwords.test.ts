import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("hashPassword / verifyPassword (scrypt)", () => {
  it("produces a hash that verifies against the original password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("never stores the plaintext password in the hash string", () => {
    const hash = hashPassword("my-secret-password");
    expect(hash).not.toContain("my-secret-password");
  });

  it("produces a different hash for the same password on each call (random salt)", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("returns false rather than throwing for a malformed stored hash", () => {
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "scrypt:onlyonefield")).toBe(false);
  });

  it("returns false for an unknown hash scheme prefix", () => {
    expect(verifyPassword("anything", "md5:abcd:1234")).toBe(false);
  });

  it("handles unicode passwords correctly", () => {
    const hash = hashPassword("mötdepässe🔒éàü");
    expect(verifyPassword("mötdepässe🔒éàü", hash)).toBe(true);
    expect(verifyPassword("motdepasse", hash)).toBe(false);
  });
});
