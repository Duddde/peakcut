import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isClaudeMotionConfigured } from "@/lib/motion/ClaudeMotionDesigner";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getRequestActorAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import {
  checkTrialJobQuota,
  getSharedPublicTrialRateLimiters,
  tooManyRequests,
  type PublicTrialRateLimiters,
} from "@/lib/publicTrial/quotas";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { attachChain, buildAutoPipelineChain, ChainConfigurationError, type ChainStep } from "@/lib/jobs/chain";
import { JobInputParseError, parsePipeline } from "@/lib/jobs/parseJobInput";
import { redactJobForResponse } from "@/lib/jobs/redactJob";
import { createFixedWindowRateLimiter, type RateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import { validateYoutubeUrl } from "@/lib/youtube/validateYoutubeUrl";

/**
 * Validates a submitted YouTube URL and enqueues the background job that
 * downloads the corresponding video so it can be fed to the rest of the
 * pipeline (transcription → analysis → tracking → export).
 *
 * The download itself never happens inline: a full video takes minutes,
 * which is not something an HTTP request should hold open. Like every
 * other long-running action in PeakCut this route only inserts a "queued"
 * row; the separate worker process (scripts/run-job-worker.ts) is what
 * actually fetches the bytes.
 *
 * A download is always tied to an authenticated user's own project — the
 * same ownership rule as /api/jobs — and rate-limited per user, so this
 * endpoint can never be used as an open, anonymous fetch-anything proxy.
 * Acquiring the file grants no export right: the rights confirmation and
 * export authorization gates are untouched (see lib/workflow/exportGate).
 *
 * With PEAKCUT_PUBLIC_TRIAL=1, an anonymous trial actor may also queue a
 * download — on its own ephemeral project only, with `rightsConfirmed: true`
 * in the body, under the trial's request rate and per-trial download cap;
 * the worker then applies the trial duration/size/time limits (see
 * jobs/handlers). A video YouTube refuses to serve (bot check, sign-in,
 * DRM, members-only…) fails the job with that reason — nothing here or in
 * the worker tries to get around it.
 *
 * An account may add `pipeline` (same options as /api/jobs) so that the
 * download is followed by transcription, analysis and framing: pasting a
 * link is then the only thing the user has to do. The chain is built here,
 * on the server, and refused to a trial for the same reason /api/jobs
 * refuses it — chained steps skip the per-kind trial quota.
 */

export interface DownloadYoutubeRouteOptions {
  deps?: AppDeps;
  rateLimiter?: RateLimiter;
  trialRateLimiters?: PublicTrialRateLimiters;
}

export function createDownloadYoutubeHandler(options: DownloadYoutubeRouteOptions = {}) {
  const rateLimiter =
    options.rateLimiter ?? createFixedWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 });

  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(options.deps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    const user = actor.user;

    const limited = rateLimiter.consume(`download-youtube:${user.id}`);
    if (!limited.allowed) {
      const response = NextResponse.json(
        { ok: false, error: "Trop de téléchargements demandés. Réessayez dans une minute." },
        { status: 429 }
      );
      if (limited.retryAfterMs) {
        response.headers.set("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      }
      return response;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ ok: false, error: "Le corps de la requête doit être un objet." }, { status: 400 });
    }
    const { url, projectId, idempotencyKey, rightsConfirmed, pipeline } = body as {
      url?: unknown;
      projectId?: unknown;
      idempotencyKey?: unknown;
      rightsConfirmed?: unknown;
      pipeline?: unknown;
    };

    if (typeof url !== "string") {
      return NextResponse.json(
        { ok: false, error: "Le champ 'url' est requis et doit être une chaîne." },
        { status: 400 }
      );
    }
    if (typeof projectId !== "string" || projectId.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "Le champ 'projectId' est requis." }, { status: 400 });
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0)) {
      return NextResponse.json(
        { ok: false, error: "idempotencyKey doit être une chaîne non vide." },
        { status: 400 }
      );
    }

    const validation = validateYoutubeUrl(url);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 422 });
    }

    const projectRepo = new SqliteProjectRepository(deps.db);
    const ownerId = projectRepo.getProjectOwnerId(projectId.trim());
    if (ownerId === null || ownerId !== user.id) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    const normalizedKey = typeof idempotencyKey === "string" ? idempotencyKey : null;
    if (actor.kind === "trial") {
      // No account stands behind a trial download, so the visitor's own
      // rights confirmation for this video is required on every request.
      if (rightsConfirmed !== true) {
        return NextResponse.json(
          { ok: false, error: "Confirmez détenir les droits sur cette vidéo avant de la télécharger." },
          { status: 403 }
        );
      }
      const limiter = (options.trialRateLimiters ?? getSharedPublicTrialRateLimiters()).jobRequests;
      const limited = limiter.consume(`trial-jobs:${user.id}`);
      if (!limited.allowed) {
        return tooManyRequests("Trop de traitements demandés pendant l'essai. Réessayez dans une minute.", limited.retryAfterMs);
      }
      // Synchronous check immediately followed by createJob — see checkTrialJobQuota.
      const quotaError = checkTrialJobQuota(deps.db, {
        ownerId: user.id,
        projectId: projectId.trim(),
        kind: "download",
        idempotencyKey: normalizedKey,
      });
      if (quotaError) {
        return NextResponse.json({ ok: false, error: quotaError }, { status: 429 });
      }
    }

    let chain: ChainStep[] = [];
    try {
      const pipelineOptions = parsePipeline(pipeline);
      if (pipelineOptions && actor.kind === "trial") {
        return NextResponse.json(
          { ok: false, error: "L'enchaînement automatique n'est pas disponible pendant l'essai public." },
          { status: 403 }
        );
      }
      if (pipelineOptions) {
        // A new source makes the previous cut meaningless: re-cut from its transcript.
        chain = buildAutoPipelineChain("download", {
          resegment: true,
          ...pipelineOptions,
          // Whether Claude Motion closes the chain is the server's call.
          motion: isClaudeMotionConfigured(),
        });
      }
    } catch (err) {
      if (err instanceof JobInputParseError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
      }
      if (err instanceof ChainConfigurationError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 422 });
      }
      throw err;
    }

    const jobRepo = new SqliteJobRepository(deps.db);
    const { job, created } = jobRepo.createJob({
      id: randomUUID(),
      projectId: projectId.trim(),
      kind: "download",
      // The *normalized* URL is what gets persisted and downloaded, so a
      // tracking/playlist parameter riding along on the submitted link is
      // dropped here rather than handed to yt-dlp.
      payload: attachChain({ url: validation.normalizedUrl, videoId: validation.videoId }, chain),
      idempotencyKey: normalizedKey,
      now: new Date().toISOString(),
    });

    if (!created && job.projectId !== projectId.trim()) {
      return NextResponse.json(
        { ok: false, error: "idempotencyKey déjà utilisée pour un autre projet." },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        videoId: validation.videoId,
        normalizedUrl: validation.normalizedUrl,
        job: redactJobForResponse(job),
      },
      { status: created ? 201 : 200 }
    );
  };
}

export const POST = createDownloadYoutubeHandler();
