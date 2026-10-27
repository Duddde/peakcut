import type { JobKind } from "@/lib/jobs/types";

/**
 * Temporary public trial: lets an anonymous visitor run the full YouTube →
 * studio → preview/watermarked test render path on ephemeral, isolated
 * projects, without creating an account or signing in.
 *
 * Off unless the server is started with PEAKCUT_PUBLIC_TRIAL=1 — any other
 * value (unset, "true", "0"…) keeps it disabled. With the flag off, the
 * trial cookie is ignored everywhere and every route behaves exactly as it
 * did before this mode existed.
 *
 * This is a server-only switch: it is read per request (never inlined at
 * build time) and never exposed through a NEXT_PUBLIC_ variable.
 */
export function isPublicTrialEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEAKCUT_PUBLIC_TRIAL === "1";
}

export interface PublicTrialLimits {
  /** Lifetime of a trial session and of everything attached to it (projects, jobs, files). */
  ttlMs: number;
  /** Trial sessions alive at the same time, across all visitors. */
  maxActiveTrials: number;
  /** New trial sessions per client IP per window. */
  startsPerIp: number;
  startsWindowMs: number;
  /** Ephemeral projects per trial session (one per tested video). */
  maxProjectsPerTrial: number;
  /** Total YouTube downloads per trial session, across its projects (whatever their outcome). */
  maxDownloadsPerTrial: number;
  /** Total jobs per kind per trial session, across its projects (whatever their outcome). */
  maxJobsPerKind: Record<Exclude<JobKind, "download">, number>;
  /** Job submissions (any kind) per trial session per minute. */
  jobRequestsPerMinute: number;
  /** Watermarked previews per trial session per window. */
  previewsPerWindow: number;
  previewsWindowMs: number;
  /** Download caps applied by the worker to trial projects — never looser than the account defaults. */
  maxDurationSec: number;
  maxBytes: number;
  downloadTimeoutMs: number;
}

/**
 * Hard caps for the public trial, enforced server-side whatever the client
 * sends. Raised enough to really test a long YouTube video end to end, but
 * still bounded: every number here is a ceiling a visitor cannot exceed.
 */
export const PUBLIC_TRIAL_LIMITS: PublicTrialLimits = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxActiveTrials: 25,
  startsPerIp: 3,
  startsWindowMs: 60 * 60 * 1000,
  maxProjectsPerTrial: 10,
  maxDownloadsPerTrial: 10,
  // Claude Motion bills the operator's Anthropic account per request: an
  // anonymous visitor does not get to spend it.
  maxJobsPerKind: { transcription: 10, analysis: 20, tracking: 10, render: 10, motion: 0 },
  jobRequestsPerMinute: 20,
  previewsPerWindow: 30,
  previewsWindowMs: 60 * 60 * 1000,
  maxDurationSec: 60 * 60,
  maxBytes: 2 * 1024 * 1024 * 1024,
  downloadTimeoutMs: 30 * 60 * 1000,
};

/** The subset of limits shown to the visitor (and returned by GET /api/public-trial). */
export function describePublicTrialLimits(limits: PublicTrialLimits = PUBLIC_TRIAL_LIMITS) {
  return {
    ttlMinutes: Math.round(limits.ttlMs / 60_000),
    maxDurationMinutes: Math.round(limits.maxDurationSec / 60),
    maxSizeMb: Math.round(limits.maxBytes / (1024 * 1024)),
    maxDownloads: limits.maxDownloadsPerTrial,
    maxRenders: limits.maxJobsPerKind.render,
    maxTranscriptions: limits.maxJobsPerKind.transcription,
    maxPreviewsPerHour: Math.round((limits.previewsPerWindow * 60 * 60 * 1000) / limits.previewsWindowMs),
  };
}

export type PublicTrialLimitsSummary = ReturnType<typeof describePublicTrialLimits>;
