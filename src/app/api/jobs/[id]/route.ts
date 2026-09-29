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
 * Ownership is resolved via the job's project owner, same 404-for-both
 * pattern as /api/projects/[id]: a job that doesn't exist and a job that
 * belongs to someone else are indistinguishable to the caller.
 */
export function createJobGetHandler(injectedDeps?: AppDeps) {
  return async function GET(request: NextRequest, context: RouteContext) {
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

    const job = jobRepo.getJobById(id);
    if (!job) {
      return NextResponse.json({ ok: false, error: "Job introuvable." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, job: redactJobForResponse(job) });
  };
}

export const GET = createJobGetHandler();
