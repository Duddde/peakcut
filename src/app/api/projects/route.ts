import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { Project } from "@/lib/domain/types";

const DEFAULT_TITLE = "Nouveau projet";

export function createProjectsListHandler(injectedDeps?: AppDeps) {
  return async function GET(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const repo = new SqliteProjectRepository(deps.db);
    const projects = repo.listProjectsByOwner(user.id);
    return NextResponse.json({ ok: true, projects });
  };
}

/**
 * Creates a new, empty project owned by the caller: no media imported yet
 * (source has no localFilePath/youtubeUrl — the studio already treats that
 * as "preview only" everywhere), analysis_preview workflow phase, no
 * segments. Real content is added afterward via ingestion/analysis and a
 * PATCH to this project.
 */
export function createProjectsCreateHandler(injectedDeps?: AppDeps) {
  return async function POST(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      const json = await request.json();
      if (typeof json === "object" && json !== null) body = json as Record<string, unknown>;
    } catch {
      // An empty/invalid body is fine here — every field has a safe default.
    }

    const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : DEFAULT_TITLE;
    const now = new Date().toISOString();

    const project: Project = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      source: {
        id: randomUUID(),
        type: "local-upload",
        title: "Aucun média importé",
        durationSec: 0,
        originTimestamp: now,
        confidence: 0,
      },
      transcript: null,
      segments: [],
      timeline: null,
      workflow: createInitialWorkflow(),
    };

    const repo = new SqliteProjectRepository(deps.db);
    repo.createProject(user.id, project);

    return NextResponse.json({ ok: true, project }, { status: 201 });
  };
}

export const GET = createProjectsListHandler();
export const POST = createProjectsCreateHandler();
