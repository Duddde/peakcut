// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createTestAppDeps } from "../../../../test/helpers/testAppDeps";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import { TRIAL_COOKIE_NAME } from "@/lib/publicTrial/trialCookie";
import { PUBLIC_TRIAL_LIMITS } from "@/lib/publicTrial/config";
import { createPublicTrialRateLimiters } from "@/lib/publicTrial/quotas";
import { createFixedWindowRateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import { createPublicTrialEndHandler, createPublicTrialStartHandler, createPublicTrialStatusHandler } from "./route";
import { createProjectsCreateHandler, createProjectsListHandler } from "../projects/route";
import { createProjectGetHandler, createProjectPatchHandler } from "../projects/[id]/route";
import { createProjectJobsListHandler } from "../projects/[id]/jobs/route";
import { createJobsCreateHandler } from "../jobs/route";
import { createJobGetHandler } from "../jobs/[id]/route";
import { createJobCancelHandler } from "../jobs/[id]/cancel/route";
import { createDownloadYoutubeHandler } from "../download-youtube/route";
import { createExportSegmentHandler } from "../export-segment/route";
import { createPreviewSegmentHandler } from "../preview-segment/route";
import { createMeHandler } from "../auth/me/route";

const VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const STORAGE = { downloadsBaseDir: "/nonexistent/d", uploadsBaseDir: "/nonexistent/u", exportsBaseDir: "/nonexistent/e" };

function req(url: string, init: { method?: string; body?: unknown; cookies?: Record<string, string>; ip?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = Object.entries(init.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  if (init.ip) headers.set("x-forwarded-for", init.ip);
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Value of the trial cookie set by a response, or null. */
function trialCookieFrom(res: Response): { value: string; attributes: string } | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${TRIAL_COOKIE_NAME}=`));
  if (!header) return null;
  const [pair, ...attributes] = header.split(";");
  return { value: pair.slice(TRIAL_COOKIE_NAME.length + 1), attributes: attributes.join(";") };
}

function makeAccount(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(user.id, new Date(Date.now() + 3_600_000).toISOString());
  return { user, cookies: { [SESSION_COOKIE_NAME]: signSessionId(session.id, deps.authSecret) } };
}

const FLAG_ON = { PEAKCUT_PUBLIC_TRIAL: "1" } as unknown as NodeJS.ProcessEnv;
const FLAG_OFF = {} as unknown as NodeJS.ProcessEnv;

async function startTrial(deps: AppDeps, ip = "203.0.113.1") {
  const POST = createPublicTrialStartHandler({
    deps,
    env: FLAG_ON,
    rateLimiters: createPublicTrialRateLimiters(),
    storageRoots: STORAGE,
  });
  const res = await POST(req("/api/public-trial", { method: "POST", ip }));
  expect(res.status).toBe(201);
  const cookie = trialCookieFrom(res);
  expect(cookie).not.toBeNull();
  return { [TRIAL_COOKIE_NAME]: cookie!.value };
}

async function createProject(deps: AppDeps, cookies: Record<string, string>) {
  const res = await createProjectsCreateHandler(deps)(req("/api/projects", { method: "POST", body: { title: "T" }, cookies }));
  return { res, json: await res.json() };
}

function permissive() {
  return createFixedWindowRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/public-trial with the flag off", () => {
  it("reports disabled, refuses to start, and never sets a cookie", async () => {
    const deps = createTestAppDeps();
    const status = await createPublicTrialStatusHandler({ deps, env: FLAG_OFF })(req("/api/public-trial"));
    expect(await status.json()).toEqual({ ok: true, enabled: false });

    const start = await createPublicTrialStartHandler({ deps, env: FLAG_OFF })(req("/api/public-trial", { method: "POST" }));
    expect(start.status).toBe(404);
    expect(trialCookieFrom(start)).toBeNull();
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM trial_actors").get()).toEqual({ n: 0 });
  });

  it("makes a trial cookie minted while it was on worthless on every trial-capable route", async () => {
    const deps = createTestAppDeps();
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const cookies = await startTrial(deps);
    const { json } = await createProject(deps, cookies);
    const projectId = json.project.id as string;

    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "0");
    expect((await createProject(deps, cookies)).res.status).toBe(401);
    expect((await createProjectGetHandler(deps)(req(`/api/projects/${projectId}`, { cookies }), ctx(projectId))).status).toBe(401);
    expect(
      (await createProjectJobsListHandler(deps)(req(`/api/projects/${projectId}/jobs`, { cookies }), ctx(projectId))).status
    ).toBe(401);
    expect(
      (await createJobsCreateHandler(deps)(req("/api/jobs", { method: "POST", body: { projectId, kind: "analysis" }, cookies })))
        .status
    ).toBe(401);
    expect(
      (
        await createDownloadYoutubeHandler({ deps, rateLimiter: permissive() })(
          req("/api/download-youtube", { method: "POST", body: { url: VALID_URL, projectId }, cookies })
        )
      ).status
    ).toBe(401);
    const preview = createPreviewSegmentHandler({ uploadsBaseDir: "/nonexistent/u", previewsBaseDir: "/nonexistent/p", appDeps: deps });
    expect((await preview(req("/api/preview-segment", { method: "POST", body: { projectId, segmentId: "s" }, cookies }))).status).toBe(401);
  });
});

describe("/api/public-trial with the flag on", () => {
  it("starts a trial with a signed, httpOnly, TTL-bound cookie and reports it", async () => {
    const deps = createTestAppDeps();
    const POST = createPublicTrialStartHandler({ deps, env: FLAG_ON, rateLimiters: createPublicTrialRateLimiters(), storageRoots: STORAGE });
    const res = await POST(req("/api/public-trial", { method: "POST", ip: "198.51.100.7" }));
    expect(res.status).toBe(201);
    const cookie = trialCookieFrom(res)!;
    expect(cookie.attributes).toMatch(/HttpOnly/i);
    expect(cookie.attributes).toMatch(/SameSite=lax/i);
    const maxAge = Number(cookie.attributes.match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(PUBLIC_TRIAL_LIMITS.ttlMs / 1000);

    const status = await createPublicTrialStatusHandler({ deps, env: FLAG_ON })(
      req("/api/public-trial", { cookies: { [TRIAL_COOKIE_NAME]: cookie.value } })
    );
    const json = await status.json();
    expect(json).toMatchObject({ enabled: true, account: false, trial: { active: true } });
    expect(json.limits.maxDownloads).toBe(PUBLIC_TRIAL_LIMITS.maxDownloadsPerTrial);
  });

  it("resumes rather than re-creating a trial for a browser that already has one", async () => {
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);
    const POST = createPublicTrialStartHandler({ deps, env: FLAG_ON, rateLimiters: createPublicTrialRateLimiters(), storageRoots: STORAGE });
    const res = await POST(req("/api/public-trial", { method: "POST", cookies }));
    expect(await res.json()).toMatchObject({ ok: true, resumed: true });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM trial_actors").get()).toEqual({ n: 1 });
  });

  it("rate-limits trial starts per IP", async () => {
    const deps = createTestAppDeps();
    const POST = createPublicTrialStartHandler({
      deps,
      env: FLAG_ON,
      rateLimiters: createPublicTrialRateLimiters({ ...PUBLIC_TRIAL_LIMITS, startsPerIp: 2 }),
      storageRoots: STORAGE,
    });
    const start = (ip: string) => POST(req("/api/public-trial", { method: "POST", ip }));
    expect((await start("192.0.2.1")).status).toBe(201);
    expect((await start("192.0.2.1")).status).toBe(201);
    const limited = await start("192.0.2.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
    expect((await start("192.0.2.2")).status).toBe(201);
  });

  it("refuses new trials once the global capacity is reached", async () => {
    const deps = createTestAppDeps();
    const POST = createPublicTrialStartHandler({
      deps,
      env: FLAG_ON,
      limits: { ...PUBLIC_TRIAL_LIMITS, maxActiveTrials: 1 },
      rateLimiters: createPublicTrialRateLimiters(),
      storageRoots: STORAGE,
    });
    expect((await POST(req("/api/public-trial", { method: "POST", ip: "192.0.2.1" }))).status).toBe(201);
    expect((await POST(req("/api/public-trial", { method: "POST", ip: "192.0.2.9" }))).status).toBe(503);
  });

  it("frees capacity held by expired trials when a new one starts", async () => {
    const deps = createTestAppDeps();
    let now = Date.now();
    const POST = createPublicTrialStartHandler({
      deps,
      env: FLAG_ON,
      limits: { ...PUBLIC_TRIAL_LIMITS, maxActiveTrials: 1 },
      rateLimiters: createPublicTrialRateLimiters(),
      storageRoots: STORAGE,
      now: () => now,
    });
    expect((await POST(req("/api/public-trial", { method: "POST", ip: "192.0.2.1" }))).status).toBe(201);
    now += PUBLIC_TRIAL_LIMITS.ttlMs + 1;
    expect((await POST(req("/api/public-trial", { method: "POST", ip: "192.0.2.2" }))).status).toBe(201);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM trial_actors").get()).toEqual({ n: 1 });
  });

  it("does not start a trial for a signed-in account", async () => {
    const deps = createTestAppDeps();
    const { cookies } = makeAccount(deps, "alice@example.com");
    const POST = createPublicTrialStartHandler({ deps, env: FLAG_ON, rateLimiters: createPublicTrialRateLimiters(), storageRoots: STORAGE });
    expect((await POST(req("/api/public-trial", { method: "POST", cookies }))).status).toBe(409);
  });

  it("ends a trial on DELETE: data removed, cookie cleared", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);
    const { json } = await createProject(deps, cookies);
    const res = await createPublicTrialEndHandler({ deps, env: FLAG_ON, storageRoots: STORAGE })(
      req("/api/public-trial", { method: "DELETE", cookies })
    );
    expect(res.status).toBe(200);
    expect(trialCookieFrom(res)?.attributes).toMatch(/Max-Age=0/i);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(json.project.id)).toEqual({ n: 0 });
  });
});

describe("public trial journey: YouTube → ephemeral project → studio jobs → preview", () => {
  it("runs the whole trial path within its limits", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);

    // Ephemeral projects: capped per trial.
    const { res: created, json } = await createProject(deps, cookies);
    expect(created.status).toBe(201);
    const projectId = json.project.id as string;
    for (let i = 1; i < PUBLIC_TRIAL_LIMITS.maxProjectsPerTrial; i++) {
      expect((await createProject(deps, cookies)).res.status).toBe(201);
    }
    expect((await createProject(deps, cookies)).res.status).toBe(429);

    // The studio learns it is in trial mode, with its limits.
    const got = await createProjectGetHandler(deps)(req(`/api/projects/${projectId}`, { cookies }), ctx(projectId));
    const gotJson = await got.json();
    expect(gotJson).toMatchObject({ ok: true, access: "trial", trial: { limits: { maxDownloads: PUBLIC_TRIAL_LIMITS.maxDownloadsPerTrial } } });

    // YouTube download: requires the rights confirmation, queued, capped per trial.
    const download = createDownloadYoutubeHandler({
      deps,
      rateLimiter: permissive(),
      trialRateLimiters: createPublicTrialRateLimiters({ ...PUBLIC_TRIAL_LIMITS, jobRequestsPerMinute: 1000 }),
    });
    const dl = (key: string, rightsConfirmed = true) =>
      download(
        req("/api/download-youtube", { method: "POST", body: { url: VALID_URL, projectId, idempotencyKey: key, rightsConfirmed }, cookies })
      );
    expect((await dl("dl-unconfirmed", false)).status).toBe(403);
    const first = await dl("dl-1");
    expect(first.status).toBe(201);
    const firstJob = (await first.json()).job;
    expect((await dl("dl-1")).status).toBe(200); // idempotent retry costs nothing
    for (let i = 2; i <= PUBLIC_TRIAL_LIMITS.maxDownloadsPerTrial; i++) {
      expect((await dl(`dl-${i}`)).status).toBe(201);
    }
    const capped = await dl("dl-over");
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/limite de l'essai public/i);

    // Studio jobs: analysis/transcription allowed, raw downloads refused, client maxAttempts ignored.
    const jobs = createJobsCreateHandler(deps, { trialRateLimiters: createPublicTrialRateLimiters() });
    const job = (body: Record<string, unknown>) => jobs(req("/api/jobs", { method: "POST", body: { projectId, ...body }, cookies }));
    const analysis = await job({ kind: "analysis", maxAttempts: 10 });
    expect(analysis.status).toBe(201);
    expect((await analysis.json()).job.maxAttempts).toBe(3);
    expect((await job({ kind: "transcription", payload: { providerId: "mock-deterministic" } })).status).toBe(201);
    expect((await job({ kind: "download", payload: { url: VALID_URL } })).status).toBe(403);
    for (let i = 0; i < PUBLIC_TRIAL_LIMITS.maxJobsPerKind.render; i++) {
      expect((await job({ kind: "render", payload: { segmentId: "s" } })).status).toBe(201);
    }
    expect((await job({ kind: "render", payload: { segmentId: "s" } })).status).toBe(429);

    // Job reads/cancel on its own project.
    expect((await createJobGetHandler(deps)(req(`/api/jobs/${firstJob.id}`, { cookies }), ctx(firstJob.id))).status).toBe(200);
    expect(
      (await createProjectJobsListHandler(deps)(req(`/api/projects/${projectId}/jobs`, { cookies }), ctx(projectId))).status
    ).toBe(200);
    expect(
      (await createJobCancelHandler(deps)(req(`/api/jobs/${firstJob.id}/cancel`, { method: "POST", cookies }), ctx(firstJob.id)))
        .status
    ).toBe(200);

    // Preview resolves the owned project; no media yet ⇒ honest 422, not a fake success.
    deps.db
      .prepare(
        "INSERT INTO segments (id, project_id, position, title, start_sec, end_sec, words_json, safe_zones_json, variants_json) VALUES ('s', ?, 0, 'S', 0, 5, '[]', '[]', '[]')"
      )
      .run(projectId);
    const preview = createPreviewSegmentHandler({
      uploadsBaseDir: "/nonexistent/u",
      previewsBaseDir: "/nonexistent/p",
      downloadsBaseDir: "/nonexistent/d",
      appDeps: deps,
      rateLimiter: permissive(),
      trialRateLimiters: createPublicTrialRateLimiters(),
    });
    const previewRes = await preview(req("/api/preview-segment", { method: "POST", body: { projectId, segmentId: "s" }, cookies }));
    expect(previewRes.status).toBe(422);
    expect((await previewRes.json()).error).toMatch(/aucun média/i);
  });

  it("rate-limits trial job submissions per session across routes", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);
    const projectId = (await createProject(deps, cookies)).json.project.id as string;
    const limiters = createPublicTrialRateLimiters({ ...PUBLIC_TRIAL_LIMITS, jobRequestsPerMinute: 2 });
    const jobs = createJobsCreateHandler(deps, { trialRateLimiters: limiters });
    const download = createDownloadYoutubeHandler({ deps, rateLimiter: permissive(), trialRateLimiters: limiters });

    expect((await jobs(req("/api/jobs", { method: "POST", body: { projectId, kind: "analysis" }, cookies }))).status).toBe(201);
    expect(
      (await download(req("/api/download-youtube", { method: "POST", body: { url: VALID_URL, projectId, rightsConfirmed: true }, cookies })))
        .status
    ).toBe(201);
    expect((await jobs(req("/api/jobs", { method: "POST", body: { projectId, kind: "analysis" }, cookies }))).status).toBe(429);
  });

  it("caps trial previews per window", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);
    const projectId = (await createProject(deps, cookies)).json.project.id as string;
    deps.db
      .prepare(
        "INSERT INTO segments (id, project_id, position, title, start_sec, end_sec, words_json, safe_zones_json, variants_json) VALUES ('s', ?, 0, 'S', 0, 5, '[]', '[]', '[]')"
      )
      .run(projectId);
    deps.db.prepare("UPDATE sources SET local_file_path = '/nonexistent/u/v.mp4' WHERE project_id = ?").run(projectId);
    const preview = createPreviewSegmentHandler({
      uploadsBaseDir: "/nonexistent/u",
      previewsBaseDir: "/nonexistent/p",
      appDeps: deps,
      rateLimiter: permissive(),
      trialRateLimiters: createPublicTrialRateLimiters({ ...PUBLIC_TRIAL_LIMITS, previewsPerWindow: 1 }),
    });
    const call = () => preview(req("/api/preview-segment", { method: "POST", body: { projectId, segmentId: "s" }, cookies }));
    expect((await call()).status).toBe(404); // within quota: reaches the (missing) file
    expect((await call()).status).toBe(429);
  });
});

describe("isolation between private accounts and trial projects", () => {
  it("keeps account and trial projects mutually invisible", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const alice = makeAccount(deps, "alice@example.com");
    const privateId = (await createProject(deps, alice.cookies)).json.project.id as string;
    const trialCookies = await startTrial(deps);
    const trialId = (await createProject(deps, trialCookies)).json.project.id as string;
    const otherTrial = await startTrial(deps, "203.0.113.99");

    // Trial → private project: 404 everywhere, never 403.
    expect((await createProjectGetHandler(deps)(req(`/api/projects/${privateId}`, { cookies: trialCookies }), ctx(privateId))).status).toBe(404);
    expect(
      (await createJobsCreateHandler(deps)(req("/api/jobs", { method: "POST", body: { projectId: privateId, kind: "analysis" }, cookies: trialCookies })))
        .status
    ).toBe(404);
    expect(
      (
        await createDownloadYoutubeHandler({ deps, rateLimiter: permissive() })(
          req("/api/download-youtube", { method: "POST", body: { url: VALID_URL, projectId: privateId }, cookies: trialCookies })
        )
      ).status
    ).toBe(404);

    // Trial → another trial's project.
    expect((await createProjectGetHandler(deps)(req(`/api/projects/${trialId}`, { cookies: otherTrial }), ctx(trialId))).status).toBe(404);

    // Account → trial project.
    expect((await createProjectGetHandler(deps)(req(`/api/projects/${trialId}`, { cookies: alice.cookies }), ctx(trialId))).status).toBe(404);

    // The account still sees its own project as a plain account project, with no trial quota applied.
    const own = await createProjectGetHandler(deps)(req(`/api/projects/${privateId}`, { cookies: alice.cookies }), ctx(privateId));
    expect(await own.json()).toMatchObject({ ok: true, access: "account" });
    expect((await createProject(deps, alice.cookies)).res.status).toBe(201);
  });

  it("keeps account-only routes closed to a trial actor", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);

    expect((await createProjectsListHandler(deps)(req("/api/projects", { cookies }))).status).toBe(401);
    expect(await (await createMeHandler(deps)(req("/api/auth/me", { cookies }))).json()).toEqual({ ok: true, authenticated: false });
    const exportRes = await createExportSegmentHandler({ uploadsBaseDir: "/nonexistent/u", exportsBaseDir: "/nonexistent/e" }, deps)(
      req("/api/export-segment", { method: "POST", body: {}, cookies })
    );
    expect(exportRes.status).toBe(401);
  });

  it("never lets a trial repoint its project at another file through PATCH", async () => {
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const deps = createTestAppDeps();
    const cookies = await startTrial(deps);
    const { json } = await createProject(deps, cookies);
    const project = json.project;
    const res = await createProjectPatchHandler(deps)(
      req(`/api/projects/${project.id}`, {
        method: "PATCH",
        cookies,
        body: { title: "Renommé", source: { ...project.source, localFilePath: "/srv/peakcut/.data/uploads/alice.mp4" } },
      }),
      ctx(project.id)
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()).project;
    expect(saved.title).toBe("Renommé");
    expect(saved.source.localFilePath).toBeUndefined();
  });
});

describe("essai public et enchaînement automatique", () => {
  /**
   * Every chained step is enqueued by the worker, which never passes back
   * through the route's per-kind trial quota. Letting a trial visitor ask
   * for a pipeline would hand them the whole queue for one quota hit.
   */
  it("refuses the automatic pipeline to a trial actor, and queues nothing", async () => {
    const deps = createTestAppDeps();
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const cookies = await startTrial(deps);
    const { json } = await createProject(deps, cookies);
    const projectId = json.project.id as string;

    const res = await createJobsCreateHandler(deps)(
      req("/api/jobs", {
        method: "POST",
        body: { projectId, kind: "transcription", payload: { providerId: "openai" }, pipeline: { providerId: "openai" } },
        cookies,
      })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/essai public/i);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("still lets a trial actor run a single step at a time", async () => {
    const deps = createTestAppDeps();
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const cookies = await startTrial(deps);
    const { json } = await createProject(deps, cookies);
    const projectId = json.project.id as string;

    const res = await createJobsCreateHandler(deps)(
      req("/api/jobs", {
        method: "POST",
        body: { projectId, kind: "transcription", payload: { providerId: "openai" } },
        cookies,
      })
    );

    expect(res.status).toBe(201);
  });
});
