import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
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
 */
export function createJobsCreateHandler(injectedDeps?: AppDeps) {
  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

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

    const jobRepo = new SqliteJobRepository(deps.db);
    const { job, created } = jobRepo.createJob({
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
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
