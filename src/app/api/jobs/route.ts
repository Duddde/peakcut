import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
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
import { JobInputParseError, parseCreateJobInput } from "@/lib/jobs/parseJobInput";
import { redactJobForResponse } from "@/lib/jobs/redactJob";

/**
 * Enqueues a background job. This route only ever inserts a "queued" row —
 * it never runs the job inline and never spawns a worker itself; a
 * separately-run worker process (scripts/run-job-worker.ts) is what
 * actually claims and executes jobs. Ownership of the target project is
 * required, exactly like the /api/projects/[id] routes, and an
 * `idempotencyKey` lets a client safely retry a submission without risking
 * a duplicate job.
 *
 * A public-trial actor (PEAKCUT_PUBLIC_TRIAL=1) may enqueue jobs on its own
 * ephemeral project only, under the trial's request rate and per-project
 * caps (checkTrialJobQuota). A trial "download" must go through
 * /api/download-youtube, which validates the URL — never a raw payload here.
 */
export function createJobsCreateHandler(
  injectedDeps?: AppDeps,
  options: { trialRateLimiters?: PublicTrialRateLimiters } = {}
) {
  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    const user = actor.user;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    let input;
    try {
      input = parseCreateJobInput(json);
    } catch (err) {
      const message = err instanceof JobInputParseError ? err.message : "Corps de requête invalide.";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const projectRepo = new SqliteProjectRepository(deps.db);
    const ownerId = projectRepo.getProjectOwnerId(input.projectId);
    if (ownerId === null || ownerId !== user.id) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    if (actor.kind === "trial") {
      if (input.kind === "download") {
        return NextResponse.json(
          { ok: false, error: "En essai public, le téléchargement passe uniquement par /api/download-youtube." },
          { status: 403 }
        );
      }
      const limiter = (options.trialRateLimiters ?? getSharedPublicTrialRateLimiters()).jobRequests;
      const limited = limiter.consume(`trial-jobs:${user.id}`);
      if (!limited.allowed) {
        return tooManyRequests("Trop de traitements demandés pendant l'essai. Réessayez dans une minute.", limited.retryAfterMs);
      }
      // No await between this check and createJob below: the count and the
      // insert can't interleave with another request in this process.
      const quotaError = checkTrialJobQuota(deps.db, {
        ownerId: user.id,
        projectId: input.projectId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
      });
      if (quotaError) {
        return NextResponse.json({ ok: false, error: quotaError }, { status: 429 });
      }
    }

    const jobRepo = new SqliteJobRepository(deps.db);
    const { job, created } = jobRepo.createJob({
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      payload: input.payload,
      // A trial can't buy itself extra worker time through retries.
      maxAttempts: actor.kind === "trial" ? undefined : input.maxAttempts,
      idempotencyKey: input.idempotencyKey,
      now: new Date().toISOString(),
    });

    // idempotency_key is unique across the whole table (not scoped per
    // project/user), so a key collision against a *different* project must
    // never silently hand back that other project's job — that would leak
    // cross-tenant data through a guessed/reused key.
    if (!created && job.projectId !== input.projectId) {
      return NextResponse.json(
        { ok: false, error: "idempotencyKey déjà utilisée pour un autre projet." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, job: redactJobForResponse(job) }, { status: created ? 201 : 200 });
  };
}

export const POST = createJobsCreateHandler();
