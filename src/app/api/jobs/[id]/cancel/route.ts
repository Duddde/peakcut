import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { redactJobForResponse } from "@/lib/jobs/redactJob";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Requests cancellation of a queued/running job. This is cooperative for a
 * "running" job: it flips the row to "cancelled" immediately so no future
 * queued attempt starts, but a worker already mid-handler for this job
 * finds out only when it next tries to report progress or finish — see
 * JobRepository.updateProgress/succeedJob/failJob, which are all
 * conditioned on `status = 'running'` and silently no-op once a job has
 * been cancelled out from under them.
 */
export function createJobCancelHandler(injectedDeps?: AppDeps) {
  return async function POST(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const jobRepo = new SqliteJobRepository(deps.db);
    const ownerId = jobRepo.getJobOwnerId(id);
    if (ownerId === null || ownerId !== user.id) {
      return NextResponse.json({ ok: false, error: "Job introuvable." }, { status: 404 });
    }

    const cancelled = jobRepo.cancelJob(id, new Date().toISOString());
    const job = jobRepo.getJobById(id);
    if (!job) {
      return NextResponse.json({ ok: false, error: "Job introuvable." }, { status: 404 });
    }
    if (!cancelled) {
      return NextResponse.json(
        { ok: false, error: `Ce job est déjà "${job.status}" et ne peut plus être annulé.`, job: redactJobForResponse(job) },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, job: redactJobForResponse(job) });
  };
}

export const POST = createJobCancelHandler();
