import { describe, expect, it } from "vitest";
import { MeResponseParseError, parseMeResponse } from "./parseMeResponse";

describe("parseMeResponse", () => {
  it("parses an authenticated response", () => {
    const result = parseMeResponse({
      ok: true,
      authenticated: true,
      user: { id: "u1", email: "alice@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(result.authenticated).toBe(true);
    expect(result.user?.email).toBe("alice@example.com");
  });

  it("parses an unauthenticated response with no user field", () => {
    const result = parseMeResponse({ ok: true, authenticated: false });
    expect(result.authenticated).toBe(false);
    expect(result.user).toBeNull();
  });

  it("throws when ok is not true", () => {
    expect(() => parseMeResponse({ ok: false })).toThrow(MeResponseParseError);
  });

  it("throws when authenticated is true but user is missing", () => {
    expect(() => parseMeResponse({ ok: true, authenticated: true })).toThrow(MeResponseParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseMeResponse(null)).toThrow(MeResponseParseError);
  });

  it("throws when authenticated is missing entirely", () => {
    expect(() => parseMeResponse({ ok: true })).toThrow(MeResponseParseError);
  });
});
