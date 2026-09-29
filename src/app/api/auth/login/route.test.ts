// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createLoginHandler } from "./route";
import { createTestAppDeps } from "../../../../../test/helpers/testAppDeps";
import { hashPassword } from "@/lib/auth/passwords";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SESSION_COOKIE_NAME, verifySignedSessionId } from "@/lib/auth/sessionCookie";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials and sets a session cookie", async () => {
    const deps = createTestAppDeps();
    new SqliteUserRepository(deps.db).createUser("alice@example.com", hashPassword("correct-horse"));
    const POST = createLoginHandler(deps);

    const res = await POST(postRequest({ email: "alice@example.com", password: "correct-horse" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.user.email).toBe("alice@example.com");

    const cookieValue = res.cookies.get(SESSION_COOKIE_NAME)?.value ?? "";
    expect(verifySignedSessionId(cookieValue, deps.authSecret)).not.toBeNull();
  });

  it("returns 401 with a generic message for a wrong password", async () => {
    const deps = createTestAppDeps();
    new SqliteUserRepository(deps.db).createUser("alice@example.com", hashPassword("correct-horse"));
    const POST = createLoginHandler(deps);

    const res = await POST(postRequest({ email: "alice@example.com", password: "wrong-password" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Identifiants invalides.");
  });

  it("returns the same generic 401 message for a nonexistent email (anti-enumeration)", async () => {
    const deps = createTestAppDeps();
    new SqliteUserRepository(deps.db).createUser("alice@example.com", hashPassword("correct-horse"));
    const POST = createLoginHandler(deps);

    const wrongPassword = await POST(postRequest({ email: "alice@example.com", password: "wrong" }));
    const unknownEmail = await POST(postRequest({ email: "nobody@example.com", password: "whatever" }));

    expect(wrongPassword.status).toBe(unknownEmail.status);
    const [wpJson, ueJson] = await Promise.all([wrongPassword.json(), unknownEmail.json()]);
    expect(wpJson.error).toBe(ueJson.error);
  });

  it("does not set a session cookie on failed login", async () => {
    const deps = createTestAppDeps();
    const POST = createLoginHandler(deps);
    const res = await POST(postRequest({ email: "nobody@example.com", password: "whatever" }));
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("returns 400 for a missing email or password field", async () => {
    const POST = createLoginHandler(createTestAppDeps());
    expect((await POST(postRequest({ password: "whatever" }))).status).toBe(400);
    expect((await POST(postRequest({ email: "alice@example.com" }))).status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const POST = createLoginHandler(createTestAppDeps());
    const req = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await POST(req)).status).toBe(400);
  });
});
