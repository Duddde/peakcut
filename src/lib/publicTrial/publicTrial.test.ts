// @vitest-environment node
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createTestAppDeps } from "../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import {
  getAuthenticatedUserFromRequestAsync,
  getRequestActorAsync,
  PUBLIC_TRIAL_ACCESS,
} from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { createDefaultJobHandlers, trialDownloadLimits } from "@/lib/jobs/handlers";
import type { VideoDownloader } from "@/lib/youtube/videoDownloader";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { Project } from "@/lib/domain/types";
import type { AppDeps } from "@/lib/appDeps";
import { isPublicTrialEnabled, PUBLIC_TRIAL_LIMITS } from "./config";
import { signTrialCookie, TRIAL_COOKIE_NAME, verifyTrialCookie } from "./trialCookie";
import { getProjectTrialStatus, SqliteTrialActorRepository, TrialCapacityError } from "./TrialActorRepository";
import { checkTrialJobQuota } from "./quotas";
import { cleanupExpiredTrials, deletionTargetFor } from "./cleanup";

const SECRET = "test-only-secret-" + "x".repeat(20);
const HOUR = 60 * 60 * 1000;

function emptyProject(id: string, localFilePath?: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    title: "P",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: { id: `src-${id}`, type: "local-upload", title: "s", durationSec: 10, originTimestamp: now, confidence: 1, localFilePath },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: createInitialWorkflow(),
  };
}

function requestWith(cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest("http://localhost/api/x", { headers: cookie ? { cookie } : {} });
}

function startTrial(deps: AppDeps, nowMs = Date.now()) {
  const actor = new SqliteTrialActorRepository(deps.db).create({ nowMs, ttlMs: HOUR, maxActive: 10 });
  const cookie = signTrialCookie({ actorId: actor.userId, expiresAtMs: new Date(actor.expiresAt).getTime() }, deps.authSecret);
  return { actor, cookie };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isPublicTrialEnabled", () => {
  it("is on only for the exact value '1'", () => {
    expect(isPublicTrialEnabled({ PEAKCUT_PUBLIC_TRIAL: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(isPublicTrialEnabled({ PEAKCUT_PUBLIC_TRIAL: value } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe("trial cookie", () => {
  const actorId = "11111111-2222-4333-8444-555555555555";

  it("round-trips a valid, unexpired cookie", () => {
    const value = signTrialCookie({ actorId, expiresAtMs: 2_000 }, SECRET);
    expect(verifyTrialCookie(value, SECRET, 1_000)).toEqual({ actorId, expiresAtMs: 2_000 });
  });

  it("rejects an expired cookie, a tampered expiry, a wrong secret and garbage", () => {
    const value = signTrialCookie({ actorId, expiresAtMs: 2_000 }, SECRET);
    expect(verifyTrialCookie(value, SECRET, 2_000)).toBeNull();
    expect(verifyTrialCookie(value.replace(".2000.", ".9999999.") , SECRET, 1_000)).toBeNull();
    expect(verifyTrialCookie(value, "another-secret-" + "y".repeat(20), 1_000)).toBeNull();
    expect(verifyTrialCookie("not.a.cookie", SECRET, 1_000)).toBeNull();
    expect(verifyTrialCookie(undefined, SECRET, 1_000)).toBeNull();
  });

  it("cannot be forged from an account session cookie signature (domain separation)", () => {
    const sessionStyle = signSessionId(`${actorId}.9999999999999`, SECRET);
    expect(verifyTrialCookie(sessionStyle, SECRET, 1_000)).toBeNull();
  });
});

describe("SqliteTrialActorRepository", () => {
  it("creates a password-less, Google-less user under a reserved domain", () => {
    const deps = createTestAppDeps();
    const { actor } = startTrial(deps);
    const user = new SqliteUserRepository(deps.db).findByEmail(`trial-${actor.userId}@public-trial.peakcut.invalid`);
    expect(user?.passwordHash).toBeNull();
  });

  it("enforces the global cap on live trials, ignoring expired ones", () => {
    const deps = createTestAppDeps();
    const repo = new SqliteTrialActorRepository(deps.db);
    const now = Date.now();
    repo.create({ nowMs: now - 2 * HOUR, ttlMs: HOUR, maxActive: 2 }); // already expired
    repo.create({ nowMs: now, ttlMs: HOUR, maxActive: 2 });
    repo.create({ nowMs: now, ttlMs: HOUR, maxActive: 2 });
    expect(() => repo.create({ nowMs: now, ttlMs: HOUR, maxActive: 2 })).toThrow(TrialCapacityError);
  });

  it("refuses to delete a user that isn't a trial actor", () => {
    const deps = createTestAppDeps();
    const account = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    expect(new SqliteTrialActorRepository(deps.db).delete(account.id)).toBe(false);
    expect(new SqliteUserRepository(deps.db).findById(account.id)).not.toBeNull();
  });
});

describe("actor resolution", () => {
  it("ignores a valid trial cookie when the flag is off", async () => {
    const deps = createTestAppDeps();
    const { cookie } = startTrial(deps);
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "0");
    const request = requestWith({ [TRIAL_COOKIE_NAME]: cookie });
    expect(await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS)).toBeNull();
    expect(await getAuthenticatedUserFromRequestAsync(request, deps, PUBLIC_TRIAL_ACCESS)).toBeNull();
  });

  it("returns the trial actor only for routes that opt in, when the flag is on", async () => {
    const deps = createTestAppDeps();
    const { actor, cookie } = startTrial(deps);
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const request = requestWith({ [TRIAL_COOKIE_NAME]: cookie });
    expect(await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS)).toMatchObject({
      kind: "trial",
      user: { id: actor.userId },
    });
    expect(await getAuthenticatedUserFromRequestAsync(request, deps)).toBeNull();
  });

  it("rejects a trial whose server-side row has expired, even with an unexpired cookie", async () => {
    const deps = createTestAppDeps();
    const { actor, cookie } = startTrial(deps);
    deps.db.prepare("UPDATE trial_actors SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), actor.userId);
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    expect(await getRequestActorAsync(requestWith({ [TRIAL_COOKIE_NAME]: cookie }), deps, PUBLIC_TRIAL_ACCESS)).toBeNull();
  });

  it("prefers the account when a browser carries both cookies", async () => {
    const deps = createTestAppDeps();
    const { cookie } = startTrial(deps);
    const account = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    const session = new SqliteSessionRepository(deps.db).createSession(account.id, new Date(Date.now() + HOUR).toISOString());
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "1");
    const request = requestWith({ [TRIAL_COOKIE_NAME]: cookie, [SESSION_COOKIE_NAME]: signSessionId(session.id, deps.authSecret) });
    expect(await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS)).toMatchObject({ kind: "account", user: { id: account.id } });
  });

  it("never returns a trial user through the account session path", async () => {
    const deps = createTestAppDeps();
    const { actor } = startTrial(deps);
    const session = new SqliteSessionRepository(deps.db).createSession(actor.userId, new Date(Date.now() + HOUR).toISOString());
    vi.stubEnv("PEAKCUT_PUBLIC_TRIAL", "0");
    const request = requestWith({ [SESSION_COOKIE_NAME]: signSessionId(session.id, deps.authSecret) });
    expect(await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS)).toBeNull();
  });
});

describe("checkTrialJobQuota", () => {
  it("caps each kind per trial across its projects, and lets a known idempotency key through", () => {
    const deps = createTestAppDeps();
    const { actor } = startTrial(deps);
    const ownerId = actor.userId;
    const projects = new SqliteProjectRepository(deps.db);
    projects.createProject(ownerId, emptyProject("p1"));
    projects.createProject(ownerId, emptyProject("p2"));
    const jobs = new SqliteJobRepository(deps.db);
    const max = PUBLIC_TRIAL_LIMITS.maxDownloadsPerTrial;
    for (let i = 0; i < max; i++) {
      // Alternate projects: the cap is shared by the whole trial session.
      const projectId = i % 2 === 0 ? "p1" : "p2";
      expect(checkTrialJobQuota(deps.db, { ownerId, projectId, kind: "download", idempotencyKey: null })).toBeNull();
      jobs.createJob({ id: `j${i}`, projectId, kind: "download", payload: {}, idempotencyKey: `k${i}`, now: new Date().toISOString() });
    }
    expect(checkTrialJobQuota(deps.db, { ownerId, projectId: "p1", kind: "download", idempotencyKey: null })).toMatch(/limite/i);
    expect(checkTrialJobQuota(deps.db, { ownerId, projectId: "p2", kind: "download", idempotencyKey: null })).toMatch(/limite/i);
    expect(checkTrialJobQuota(deps.db, { ownerId, projectId: "p1", kind: "download", idempotencyKey: "k0" })).toBeNull();
    // A key used by another project doesn't bypass the cap.
    expect(checkTrialJobQuota(deps.db, { ownerId, projectId: "p2", kind: "download", idempotencyKey: "k0" })).toMatch(/limite/i);
    expect(checkTrialJobQuota(deps.db, { ownerId, projectId: "p1", kind: "analysis", idempotencyKey: null })).toBeNull();
  });
});

describe("cleanup", () => {
  async function makeRoots() {
    const base = await mkdtemp(path.join(tmpdir(), "peakcut-trial-"));
    const roots = {
      downloadsBaseDir: path.join(base, "downloads"),
      uploadsBaseDir: path.join(base, "uploads"),
      exportsBaseDir: path.join(base, "exports"),
    };
    for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true });
    return { base, roots };
  }

  async function exists(target: string) {
    return stat(target).then(
      () => true,
      () => false
    );
  }

  it("maps a recorded path to the per-download directory, and refuses paths outside the roots", () => {
    const roots = { downloadsBaseDir: "/srv/d", uploadsBaseDir: "/srv/u", exportsBaseDir: "/srv/e" };
    expect(deletionTargetFor("/srv/d/abc/video.mp4", roots)).toBe("/srv/d/abc");
    expect(deletionTargetFor("/srv/e/job.mp4", roots)).toBe("/srv/e/job.mp4");
    expect(deletionTargetFor("/etc/passwd", roots)).toBeNull();
    expect(deletionTargetFor("/srv/d/../../etc/passwd", roots)).toBeNull();
    expect(deletionTargetFor("/srv/d", roots)).toBeNull();
  });

  it("deletes expired trials with their projects, jobs and files, and nothing else", async () => {
    const deps = createTestAppDeps();
    const { base, roots } = await makeRoots();
    const projects = new SqliteProjectRepository(deps.db);
    const jobs = new SqliteJobRepository(deps.db);

    const now = Date.now();
    const expired = new SqliteTrialActorRepository(deps.db).create({ nowMs: now - 3 * HOUR, ttlMs: HOUR, maxActive: 10 });
    const live = startTrial(deps, now).actor;
    const account = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");

    const expiredDir = path.join(roots.downloadsBaseDir, "dl-expired");
    await mkdir(expiredDir);
    await writeFile(path.join(expiredDir, "v.mp4"), "x");
    const renderOut = path.join(roots.exportsBaseDir, "render.mp4");
    await writeFile(renderOut, "x");
    const outsider = path.join(base, "outside.mp4");
    await writeFile(outsider, "x");
    const privateFile = path.join(roots.uploadsBaseDir, "alice.mp4");
    await writeFile(privateFile, "x");

    projects.createProject(expired.userId, emptyProject("pe", path.join(expiredDir, "v.mp4")));
    jobs.createJob({ id: "je", projectId: "pe", kind: "render", payload: {}, now: new Date().toISOString() });
    deps.db.prepare("UPDATE jobs SET result_json = ? WHERE id = 'je'").run(JSON.stringify({ outputPath: renderOut, extra: { outputPath: outsider } }));
    projects.createProject(live.userId, emptyProject("pl"));
    projects.createProject(account.id, emptyProject("pa", privateFile));

    expect(getProjectTrialStatus(deps.db, "pe", now)).toBe("expired");
    expect(getProjectTrialStatus(deps.db, "pl", now)).toBe("active");
    expect(getProjectTrialStatus(deps.db, "pa", now)).toBe("none");

    expect(await cleanupExpiredTrials(deps.db, { roots, nowMs: now })).toBe(1);

    expect(projects.getProjectById("pe")).toBeNull();
    expect(jobs.getJobById("je")).toBeNull();
    expect(new SqliteUserRepository(deps.db).findById(expired.userId)).toBeNull();
    expect(await exists(expiredDir)).toBe(false);
    expect(await exists(renderOut)).toBe(false);
    // A path outside every storage root is never removed, whatever a job row says.
    expect(await exists(outsider)).toBe(true);
    // Live trials and private accounts are untouched.
    expect(projects.getProjectById("pl")).not.toBeNull();
    expect(projects.getProjectById("pa")).not.toBeNull();
    expect(await exists(privateFile)).toBe(true);
  });
});

describe("worker handlers for trial projects", () => {
  function fakeDownloader(label: string, calls: string[]): VideoDownloader {
    return {
      async download() {
        calls.push(label);
        throw new Error(`stop:${label}`);
      },
    };
  }

  it("tightens download limits to the stricter of deployment and trial", () => {
    const limits = trialDownloadLimits({ maxDurationSec: 60, maxBytes: 10 * 1024 ** 3 });
    expect(limits.maxDurationSec).toBe(60);
    expect(limits.maxBytes).toBe(PUBLIC_TRIAL_LIMITS.maxBytes);
    expect(limits.downloadTimeoutMs).toBe(PUBLIC_TRIAL_LIMITS.downloadTimeoutMs);
  });

  it("uses the trial downloader for a trial project and the regular one for an account", async () => {
    const deps = createTestAppDeps();
    const { actor } = startTrial(deps);
    const account = new SqliteUserRepository(deps.db).createUser("alice@example.com", "hash");
    const projects = new SqliteProjectRepository(deps.db);
    projects.createProject(actor.userId, emptyProject("pt"));
    projects.createProject(account.id, emptyProject("pa"));
    const calls: string[] = [];
    const handlers = createDefaultJobHandlers({
      db: deps.db,
      exportsBaseDir: "/tmp/unused",
      videoDownloader: fakeDownloader("account", calls),
      trialVideoDownloader: fakeDownloader("trial", calls),
    });
    const job = (projectId: string) =>
      ({ id: "j", projectId, kind: "download", payload: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }) as never;

    await expect(handlers.download({ job: job("pt"), reportProgress: () => {} })).rejects.toThrow("stop:trial");
    await expect(handlers.download({ job: job("pa"), reportProgress: () => {} })).rejects.toThrow("stop:account");
    expect(calls).toEqual(["trial", "account"]);
  });

  it("refuses to run any job for an expired trial project", async () => {
    const deps = createTestAppDeps();
    const actor = new SqliteTrialActorRepository(deps.db).create({ nowMs: Date.now() - 3 * HOUR, ttlMs: HOUR, maxActive: 10 });
    new SqliteProjectRepository(deps.db).createProject(actor.userId, emptyProject("pe"));
    const calls: string[] = [];
    const handlers = createDefaultJobHandlers({
      db: deps.db,
      exportsBaseDir: "/tmp/unused",
      trialVideoDownloader: fakeDownloader("trial", calls),
    });
    const job = { id: "j", projectId: "pe", kind: "analysis", payload: {} } as never;
    await expect(handlers.analysis({ job, reportProgress: () => {} })).rejects.toThrow(/expiré/);
    await expect(handlers.download({ job, reportProgress: () => {} })).rejects.toThrow(/expiré/);
    expect(calls).toEqual([]);
  });
});
