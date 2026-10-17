import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteAssetRepository } from "@/lib/assets/AssetRepository";
import { defaultAssetsBaseDir, deleteAsset, readAsset } from "@/lib/assets/assetStore";
import { isValidAssetId } from "@/lib/assets/imageAsset";

/**
 * One illustration: its bytes, or its removal.
 *
 * Everything a caller supplies is an id, and an id that is not one is
 * refused before any lookup. The asset is then read through its project,
 * so an id belonging to someone else resolves to nothing — the same 404
 * as an id that never existed, since distinguishing the two would leak
 * what other people have.
 *
 * Deleting removes the row and the bytes, and leaves any clip that still
 * refers to the asset exporting without it (the renderer reports the
 * missing illustration rather than failing). That is deliberate: a plan
 * is edited by its owner, and an asset they deleted should not be able to
 * block a render.
 */

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

export interface ProjectAssetHandlerOptions {
  appDeps?: AppDeps;
  assetsBaseDir?: string;
}

async function resolveOwnedAssetRequest(
  request: NextRequest,
  context: RouteContext,
  options: ProjectAssetHandlerOptions
): Promise<{ deps: AppDeps; projectId: string; assetId: string } | NextResponse> {
  const depsOrError = resolveRouteDeps(options.appDeps);
  if (depsOrError instanceof NextResponse) return depsOrError;
  const deps = depsOrError;

  const user = await getAuthenticatedUserFromRequestAsync(request, deps, PUBLIC_TRIAL_ACCESS);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
  }

  const { id, assetId } = await context.params;
  if (!isValidAssetId(assetId)) {
    return NextResponse.json({ ok: false, error: "Illustration introuvable." }, { status: 404 });
  }

  const ownerId = new SqliteProjectRepository(deps.db).getProjectOwnerId(id);
  if (ownerId === null || ownerId !== user.id) {
    return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
  }

  return { deps, projectId: id, assetId };
}

export function createProjectAssetFileHandler(options: ProjectAssetHandlerOptions = {}) {
  return async function GET(request: NextRequest, context: RouteContext) {
    const resolved = await resolveOwnedAssetRequest(request, context, options);
    if (resolved instanceof NextResponse) return resolved;

    const loaded = await readAsset(resolved.projectId, resolved.assetId, {
      baseDir: options.assetsBaseDir ?? defaultAssetsBaseDir(),
      repo: new SqliteAssetRepository(resolved.deps.db),
    });
    if (!loaded) {
      return NextResponse.json({ ok: false, error: "Illustration introuvable." }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(loaded.data), {
      headers: {
        "content-type": loaded.record.mimeType,
        // Private: an illustration belongs to one project and is served
        // only to its owner, so no shared cache may keep a copy.
        "cache-control": "private, max-age=300",
        "content-disposition": "inline",
      },
    });
  };
}

export function createProjectAssetDeleteHandler(options: ProjectAssetHandlerOptions = {}) {
  return async function DELETE(request: NextRequest, context: RouteContext) {
    const resolved = await resolveOwnedAssetRequest(request, context, options);
    if (resolved instanceof NextResponse) return resolved;

    const removed = await deleteAsset(resolved.projectId, resolved.assetId, {
      baseDir: options.assetsBaseDir ?? defaultAssetsBaseDir(),
      repo: new SqliteAssetRepository(resolved.deps.db),
    });
    if (!removed) {
      return NextResponse.json({ ok: false, error: "Illustration introuvable." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, deleted: resolved.assetId });
  };
}

export const GET = createProjectAssetFileHandler();
export const DELETE = createProjectAssetDeleteHandler();
