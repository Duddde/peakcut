import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
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
 */

export interface DownloadYoutubeRouteOptions {
  deps?: AppDeps;
  rateLimiter?: RateLimiter;
}

export function createDownloadYoutubeHandler(options: DownloadYoutubeRouteOptions = {}) {
  const rateLimiter =
    options.rateLimiter ?? createFixedWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 });

  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(options.deps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

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
    const { url, projectId, idempotencyKey } = body as {
      url?: unknown;
      projectId?: unknown;
      idempotencyKey?: unknown;
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

    const jobRepo = new SqliteJobRepository(deps.db);
    const { job, created } = jobRepo.createJob({
      id: randomUUID(),
      projectId: projectId.trim(),
      kind: "download",
      // The *normalized* URL is what gets persisted and downloaded, so a
      // tracking/playlist parameter riding along on the submitted link is
      // dropped here rather than handed to yt-dlp.
      payload: { url: validation.normalizedUrl, videoId: validation.videoId },
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
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
