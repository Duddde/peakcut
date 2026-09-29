import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { ProjectInputParseError, parseProjectUpdateInput } from "@/lib/db/parseProjectInput";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Ownership is checked strictly and uniformly across GET/PATCH/DELETE: a
 * project that exists but belongs to someone else returns 404, exactly
 * like a project that doesn't exist at all — never 403 — so a caller can't
 * use this API to enumerate other users' project ids.
 */
function assertOwnership(repo: SqliteProjectRepository, projectId: string, userId: string): NextResponse | null {
  const ownerId = repo.getProjectOwnerId(projectId);
  if (ownerId === null || ownerId !== userId) {
    return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
  }
  return null;
}

export function createProjectGetHandler(injectedDeps?: AppDeps) {
  return async function GET(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownershipError = assertOwnership(repo, id, user.id);
    if (ownershipError) return ownershipError;

    const project = repo.getProjectById(id);
    return NextResponse.json({ ok: true, project });
  };
}

export function createProjectPatchHandler(injectedDeps?: AppDeps) {
  return async function PATCH(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownershipError = assertOwnership(repo, id, user.id);
    if (ownershipError) return ownershipError;

    const existing = repo.getProjectById(id);
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    let updated;
    try {
      updated = parseProjectUpdateInput(json, existing);
    } catch (err) {
      const message = err instanceof ProjectInputParseError ? err.message : "Corps de requête invalide.";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    updated = { ...updated, updatedAt: new Date().toISOString() };

    repo.updateProject(id, updated);
    return NextResponse.json({ ok: true, project: updated });
  };
}

export function createProjectDeleteHandler(injectedDeps?: AppDeps) {
  return async function DELETE(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownershipError = assertOwnership(repo, id, user.id);
    if (ownershipError) return ownershipError;

    repo.deleteProject(id);
    return NextResponse.json({ ok: true });
  };
}

export const GET = createProjectGetHandler();
export const PATCH = createProjectPatchHandler();
export const DELETE = createProjectDeleteHandler();
