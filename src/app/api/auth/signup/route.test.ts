// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSignupHandler } from "./route";
import { createTestAppDeps } from "../../../../../test/helpers/testAppDeps";
import { SESSION_COOKIE_NAME, verifySignedSessionId } from "@/lib/auth/sessionCookie";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/signup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a user and sets a signed, httpOnly session cookie", async () => {
    const deps = createTestAppDeps();
    const POST = createSignupHandler(deps);
    const res = await POST(postRequest({ email: "alice@example.com", password: "correct-horse" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.user.email).toBe("alice@example.com");
    expect(json.user).not.toHaveProperty("passwordHash");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");

    const cookieValue = res.cookies.get(SESSION_COOKIE_NAME)?.value ?? "";
    expect(verifySignedSessionId(cookieValue, deps.authSecret)).not.toBeNull();
  });

  it("returns 400 for an invalid email", async () => {
    const POST = createSignupHandler(createTestAppDeps());
    const res = await POST(postRequest({ email: "not-an-email", password: "correct-horse" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a too-short password", async () => {
    const POST = createSignupHandler(createTestAppDeps());
    const res = await POST(postRequest({ email: "alice@example.com", password: "short" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 for a duplicate email", async () => {
    const deps = createTestAppDeps();
    const POST = createSignupHandler(deps);
    await POST(postRequest({ email: "dupe@example.com", password: "correct-horse" }));
    const res = await POST(postRequest({ email: "dupe@example.com", password: "another-password" }));
    expect(res.status).toBe(409);
  });

  it("returns 400 for invalid JSON", async () => {
    const POST = createSignupHandler(createTestAppDeps());
    const req = new NextRequest("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("never returns the password or its hash in the response", async () => {
    const POST = createSignupHandler(createTestAppDeps());
    const res = await POST(postRequest({ email: "alice@example.com", password: "correct-horse" }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("correct-horse");
    expect(text.toLowerCase()).not.toContain("hash");
  });

  it("returns 500 with an explicit configuration error when deps cannot be resolved (no insecure fallback)", async () => {
    vi.stubEnv("PEAKCUT_DB_PATH", "");
    vi.stubEnv("PEAKCUT_AUTH_SECRET", "");
    const POST = createSignupHandler(); // no injected deps
    const res = await POST(postRequest({ email: "alice@example.com", password: "correct-horse" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
