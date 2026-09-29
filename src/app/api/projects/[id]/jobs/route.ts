import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteJobRepository } from "@/lib/jobs/JobRepository";
import { redactJobForResponse } from "@/lib/jobs/redactJob";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function createProjectJobsListHandler(injectedDeps?: AppDeps) {
  return async function GET(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const projectRepo = new SqliteProjectRepository(deps.db);
    const ownerId = projectRepo.getProjectOwnerId(id);
    if (ownerId === null || ownerId !== user.id) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    const jobRepo = new SqliteJobRepository(deps.db);
    const jobs = jobRepo.listJobsByProject(id).map(redactJobForResponse);

    return NextResponse.json({ ok: true, jobs });
  };
}

export const GET = createProjectJobsListHandler();
