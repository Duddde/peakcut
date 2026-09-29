import { describe, expect, it } from "vitest";
import { validateSignupCredentials } from "./validateCredentials";

describe("validateSignupCredentials", () => {
  it("accepts a well-formed email and a sufficiently long password", () => {
    expect(validateSignupCredentials("alice@example.com", "correct-horse-battery")).toEqual({ ok: true });
  });

  it("rejects a non-string email", () => {
    expect(validateSignupCredentials(42, "password123").ok).toBe(false);
  });

  it("rejects an email without an @", () => {
    expect(validateSignupCredentials("not-an-email", "password123").ok).toBe(false);
  });

  it("rejects an email without a domain dot", () => {
    expect(validateSignupCredentials("alice@example", "password123").ok).toBe(false);
  });

  it("rejects a non-string password", () => {
    expect(validateSignupCredentials("alice@example.com", 12345678).ok).toBe(false);
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(validateSignupCredentials("alice@example.com", "short1").ok).toBe(false);
  });

  it("accepts a password exactly 8 characters long", () => {
    expect(validateSignupCredentials("alice@example.com", "exactly8").ok).toBe(true);
  });

  it("rejects an absurdly long password (denial-of-service guard)", () => {
    expect(validateSignupCredentials("alice@example.com", "a".repeat(1000)).ok).toBe(false);
  });

  it("trims surrounding whitespace from the email before validating", () => {
    expect(validateSignupCredentials("  alice@example.com  ", "password123").ok).toBe(true);
  });
});
