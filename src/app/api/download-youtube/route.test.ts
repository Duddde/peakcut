// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createDownloadYoutubeHandler } from "./route";
import { createProjectsCreateHandler } from "../projects/route";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { createFixedWindowRateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import type { AppDeps } from "@/lib/appDeps";

const VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function makeAuthedUserAndCookie(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  return { user, cookie: signSessionId(session.id, deps.authSecret) };
}

function postRequest(body: unknown, cookie?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  return new NextRequest("http://localhost/api/download-youtube", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: undefined,
  });
}

async function createProjectFor(deps: AppDeps, cookie: string): Promise<string> {
  const POST = createProjectsCreateHandler(deps);
  const headers = new Headers({ "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${cookie}` });
  const res = await POST(
    new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Projet" }),
      signal: undefined,
    })
  );
  const json = await res.json();
  return json.project.id as string;
}

/** A limiter generous enough that it never interferes with the test under way. */
function permissiveLimiter() {
  return createFixedWindowRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
}

describe("POST /api/download-youtube", () => {
  it("validates the URL and queues a download job for the owner's project", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);

    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });
    const res = await POST(postRequest({ url: "https://youtu.be/dQw4w9WgXcQ", projectId }, cookie));

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.videoId).toBe("dQw4w9WgXcQ");
    expect(json.normalizedUrl).toBe(VALID_URL);
    expect(json.job.kind).toBe("download");
    expect(json.job.status).toBe("queued");
    expect(json.job.projectId).toBe(projectId);

    const stored = new SqliteJobRepository(deps.db).getJobById(json.job.id);
    expect(stored?.kind).toBe("download");
    expect(stored?.payload).toEqual({ url: VALID_URL, videoId: "dQw4w9WgXcQ" });
  });

  it("queues the normalized URL, dropping playlist and timestamp parameters", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);

    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });
    const res = await POST(
      postRequest({ url: "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s", projectId }, cookie)
    );
    const json = await res.json();
    expect(json.job.payload.url).toBe(VALID_URL);
  });

  it("never downloads inline — it only ever queues", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);

    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });
    const json = await (await POST(postRequest({ url: VALID_URL, projectId }, cookie))).json();

    expect(json.job.status).toBe("queued");
    expect(json.job.startedAt).toBeNull();
    expect(json.job.finishedAt).toBeNull();
    expect(json.job.progress).toBe(0);
  });

  it("rejects an anonymous caller", async () => {
    const deps = createTestAppDeps();
    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });
    const res = await POST(postRequest({ url: VALID_URL, projectId: "whatever" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for a project the caller does not own, without revealing it exists", async () => {
    const deps = createTestAppDeps();
    const owner = makeAuthedUserAndCookie(deps, "alice@example.com");
    const intruder = makeAuthedUserAndCookie(deps, "mallory@example.com");
    const projectId = await createProjectFor(deps, owner.cookie);

    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });
    const res = await POST(postRequest({ url: VALID_URL, projectId }, intruder.cookie));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Projet introuvable.");
  });

  it("rejects a URL that is not a single public YouTube video", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);
    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });

    for (const url of [
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/@someChannel",
      "https://vimeo.com/123456",
      "pas une url",
    ]) {
      const res = await POST(postRequest({ url, projectId }, cookie));
      expect(res.status).toBe(422);
    }

    expect(new SqliteJobRepository(deps.db).listJobsByProject(projectId)).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);
    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });

    expect((await POST(postRequest("{ not json", cookie))).status).toBe(400);
    expect((await POST(postRequest({ projectId }, cookie))).status).toBe(400);
    expect((await POST(postRequest({ url: VALID_URL }, cookie))).status).toBe(400);
    expect((await POST(postRequest({ url: 42, projectId }, cookie))).status).toBe(400);
    expect((await POST(postRequest({ url: VALID_URL, projectId, idempotencyKey: "" }, cookie))).status).toBe(400);
  });

  it("returns the same job for a repeated idempotency key instead of queueing twice", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);
    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });

    const body = { url: VALID_URL, projectId, idempotencyKey: "download-once" };
    const first = await POST(postRequest(body, cookie));
    const second = await POST(postRequest(body, cookie));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).job.id).toBe((await first.json()).job.id);
    expect(new SqliteJobRepository(deps.db).listJobsByProject(projectId)).toHaveLength(1);
  });

  it("refuses to hand back another project's job on an idempotency-key collision", async () => {
    const deps = createTestAppDeps();
    const owner = makeAuthedUserAndCookie(deps, "alice@example.com");
    const intruder = makeAuthedUserAndCookie(deps, "mallory@example.com");
    const ownerProject = await createProjectFor(deps, owner.cookie);
    const intruderProject = await createProjectFor(deps, intruder.cookie);
    const POST = createDownloadYoutubeHandler({ deps, rateLimiter: permissiveLimiter() });

    await POST(postRequest({ url: VALID_URL, projectId: ownerProject, idempotencyKey: "shared" }, owner.cookie));
    const res = await POST(
      postRequest({ url: VALID_URL, projectId: intruderProject, idempotencyKey: "shared" }, intruder.cookie)
    );

    expect(res.status).toBe(409);
  });

  it("rate-limits a caller who floods the endpoint", async () => {
    const deps = createTestAppDeps();
    const { cookie } = makeAuthedUserAndCookie(deps, "alice@example.com");
    const projectId = await createProjectFor(deps, cookie);
    const POST = createDownloadYoutubeHandler({
      deps,
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });

    expect((await POST(postRequest({ url: VALID_URL, projectId }, cookie))).status).toBe(201);
    const limited = await POST(postRequest({ url: VALID_URL, projectId }, cookie));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});
