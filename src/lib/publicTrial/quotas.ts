import type { DatabaseSync } from "node:sqlite";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { JobKind } from "@/lib/jobs/types";
import { createFixedWindowRateLimiter, type RateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import { PUBLIC_TRIAL_LIMITS, type PublicTrialLimits } from "./config";

/**
 * Every trial-specific limit, in one place. Per-trial caps are counted
 * from the jobs table across all of the trial's projects (durable, whatever
 * the job's outcome); request-rate
 * caps are in-memory fixed windows — same single-process caveat as every
 * other limiter in this codebase (see fixedWindowRateLimiter).
 */

export interface PublicTrialRateLimiters {
  /** Key: client IP. */
  starts: RateLimiter;
  /** Key: trial actor id. */
  jobRequests: RateLimiter;
  /** Key: trial actor id. */
  previews: RateLimiter;
}

export function createPublicTrialRateLimiters(limits: PublicTrialLimits = PUBLIC_TRIAL_LIMITS): PublicTrialRateLimiters {
  return {
    starts: createFixedWindowRateLimiter({ maxRequests: limits.startsPerIp, windowMs: limits.startsWindowMs }),
    jobRequests: createFixedWindowRateLimiter({ maxRequests: limits.jobRequestsPerMinute, windowMs: 60_000 }),
    previews: createFixedWindowRateLimiter({ maxRequests: limits.previewsPerWindow, windowMs: limits.previewsWindowMs }),
  };
}

const GLOBAL_KEY = Symbol.for("peakcut.publicTrial.rateLimiters");

/**
 * Process-wide limiters shared by every route (a trial's job budget per
 * minute must be the same whether it goes through /api/jobs or
 * /api/download-youtube). Kept on globalThis so separately bundled route
 * modules still share one instance.
 */
export function getSharedPublicTrialRateLimiters(): PublicTrialRateLimiters {
  const holder = globalThis as unknown as Record<symbol, PublicTrialRateLimiters | undefined>;
  holder[GLOBAL_KEY] ??= createPublicTrialRateLimiters();
  return holder[GLOBAL_KEY];
}

/** First hop of X-Forwarded-For (set by the reverse proxy), same convention as /api/preview-segment. */
export function clientIpOf(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function tooManyRequests(error: string, retryAfterMs?: number): NextResponse {
  const response = NextResponse.json({ ok: false, error }, { status: 429 });
  if (retryAfterMs) response.headers.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  return response;
}

function jobLimitFor(kind: JobKind, limits: PublicTrialLimits): number {
  return kind === "download" ? limits.maxDownloadsPerTrial : limits.maxJobsPerKind[kind];
}

const KIND_LABELS: Record<JobKind, string> = {
  download: "téléchargement(s)",
  transcription: "transcription(s)",
  analysis: "analyse(s)",
  tracking: "détection(s) de cadrage",
  render: "rendu(s)",
  motion: "motion design(s)",
};

/**
 * Null when a trial project may enqueue one more job of `kind`, otherwise
 * the user-facing refusal. The cap is per trial session (`ownerId`), summed
 * over all of its projects. Resubmitting an idempotency key this project
 * already used is always allowed — it returns the existing job instead of
 * creating one, so it costs nothing against the quota.
 *
 * Must be called synchronously right before createJob (no await between
 * the two), so the check-then-insert can't interleave with another request.
 */
export function checkTrialJobQuota(
  db: DatabaseSync,
  params: { ownerId: string; projectId: string; kind: JobKind; idempotencyKey: string | null },
  limits: PublicTrialLimits = PUBLIC_TRIAL_LIMITS
): string | null {
  if (params.idempotencyKey) {
    const existing = db
      .prepare("SELECT project_id FROM jobs WHERE idempotency_key = ?")
      .get(params.idempotencyKey) as { project_id: string | null } | undefined;
    if (existing && existing.project_id === params.projectId) return null;
  }

  // A trial can't delete its projects (see DELETE /api/projects/[id]), so
  // this count can't be reset short of ending the whole trial.
  const { used } = db
    .prepare(
      `SELECT COUNT(*) AS used FROM jobs j JOIN projects p ON p.id = j.project_id
       WHERE p.owner_id = ? AND j.kind = ?`
    )
    .get(params.ownerId, params.kind) as { used: number };
  const max = jobLimitFor(params.kind, limits);
  if (Number(used) >= max) {
    return `Limite de l'essai public atteinte : ${max} ${KIND_LABELS[params.kind]} maximum par essai.`;
  }
  return null;
}

export function countProjectsOwnedBy(db: DatabaseSync, ownerId: string): number {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?").get(ownerId) as { n: number };
  return Number(n);
}
