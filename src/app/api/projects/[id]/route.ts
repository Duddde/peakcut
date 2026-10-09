import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getRequestActorAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { describePublicTrialLimits } from "@/lib/publicTrial/config";
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
 *
 * A public-trial actor (PEAKCUT_PUBLIC_TRIAL=1) reaches its own ephemeral
 * project through the very same owner_id check — trial and account
 * projects are mutually invisible. GET tells the client which kind of
 * access it has, so the studio can show trial limits instead of AccountGate.
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

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    const user = actor.user;

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownershipError = assertOwnership(repo, id, user.id);
    if (ownershipError) return ownershipError;

    const project = repo.getProjectById(id);
    if (actor.kind === "trial") {
      return NextResponse.json({
        ok: true,
        project,
        access: "trial",
        trial: { expiresAt: actor.expiresAt, limits: describePublicTrialLimits() },
      });
    }
    return NextResponse.json({ ok: true, project, access: "account" });
  };
}

export function createProjectPatchHandler(injectedDeps?: AppDeps) {
  return async function PATCH(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    const user = actor.user;

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
    // A trial visitor never chooses which file on the server its project
    // points at: the source only ever comes from the worker's own download.
    if (actor.kind === "trial") {
      updated = { ...updated, source: existing.source };
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

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    const user = actor.user;

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownershipError = assertOwnership(repo, id, user.id);
    if (ownershipError) return ownershipError;

    // Deleting one trial project would refund its jobs against the trial's
    // quotas and strand its files outside the cleanup's reach: a trial is
    // only ever deleted as a whole (DELETE /api/public-trial, or expiry).
    if (actor.kind === "trial") {
      return NextResponse.json(
        { ok: false, error: "Un projet d'essai est supprimé avec l'essai (fin de l'essai ou expiration)." },
        { status: 403 }
      );
    }

    repo.deleteProject(id);
    return NextResponse.json({ ok: true });
  };
}

export const GET = createProjectGetHandler();
export const PATCH = createProjectPatchHandler();
export const DELETE = createProjectDeleteHandler();
