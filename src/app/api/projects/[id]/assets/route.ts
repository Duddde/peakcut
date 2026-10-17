import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteAssetRepository, type AssetRecord } from "@/lib/assets/AssetRepository";
import { AssetStoreError, defaultAssetsBaseDir, saveAsset } from "@/lib/assets/assetStore";
import { MAX_ASSET_BYTES } from "@/lib/assets/imageAsset";

/**
 * The illustrations of one project: list them, or add one by uploading an
 * image.
 *
 * Ownership is the whole access control story, as everywhere else here: a
 * project that is not the caller's answers 404, never 403, so the route
 * cannot be used to find out which projects exist.
 *
 * What comes back is metadata and a URL to fetch the bytes — never a
 * filesystem path. The server knows where an asset lives; a client has no
 * use for that and no business knowing it.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function assetForResponse(record: AssetRecord): Record<string, unknown> {
  return {
    id: record.id,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    origin: record.origin,
    prompt: record.prompt,
    providerId: record.providerId,
    createdAt: record.createdAt,
    url: `/api/projects/${record.projectId}/assets/${record.id}`,
  };
}

export interface ProjectAssetsHandlerOptions {
  appDeps?: AppDeps;
  assetsBaseDir?: string;
}

async function resolveOwnedProject(
  request: NextRequest,
  context: RouteContext,
  options: ProjectAssetsHandlerOptions
): Promise<{ deps: AppDeps; projectId: string } | NextResponse> {
  const depsOrError = resolveRouteDeps(options.appDeps);
  if (depsOrError instanceof NextResponse) return depsOrError;
  const deps = depsOrError;

  const user = await getAuthenticatedUserFromRequestAsync(request, deps, PUBLIC_TRIAL_ACCESS);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await context.params;
  const ownerId = new SqliteProjectRepository(deps.db).getProjectOwnerId(id);
  if (ownerId === null || ownerId !== user.id) {
    return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
  }

  return { deps, projectId: id };
}

export function createProjectAssetsListHandler(options: ProjectAssetsHandlerOptions = {}) {
  return async function GET(request: NextRequest, context: RouteContext) {
    const resolved = await resolveOwnedProject(request, context, options);
    if (resolved instanceof NextResponse) return resolved;

    const assets = new SqliteAssetRepository(resolved.deps.db).listAssets(resolved.projectId);
    return NextResponse.json({ ok: true, assets: assets.map(assetForResponse) });
  };
}

export function createProjectAssetUploadHandler(options: ProjectAssetsHandlerOptions = {}) {
  return async function POST(request: NextRequest, context: RouteContext) {
    const resolved = await resolveOwnedProject(request, context, options);
    if (resolved instanceof NextResponse) return resolved;

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Corps de requête multipart/form-data invalide." },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Le champ 'file' est requis." }, { status: 400 });
    }
    // Checked before the bytes are read into memory, so an oversized
    // upload is refused rather than buffered first.
    if (file.size > MAX_ASSET_BYTES) {
      return NextResponse.json(
        { ok: false, error: `L'image dépasse la taille maximale autorisée (${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} Mo).` },
        { status: 422 }
      );
    }

    try {
      const record = await saveAsset(
        {
          projectId: resolved.projectId,
          data: Buffer.from(await file.arrayBuffer()),
          declaredMimeType: file.type || undefined,
          origin: "upload",
        },
        {
          baseDir: options.assetsBaseDir ?? defaultAssetsBaseDir(),
          repo: new SqliteAssetRepository(resolved.deps.db),
        }
      );
      return NextResponse.json({ ok: true, asset: assetForResponse(record) }, { status: 201 });
    } catch (err) {
      if (err instanceof AssetStoreError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 422 });
      }
      throw err;
    }
  };
}

export const GET = createProjectAssetsListHandler();
export const POST = createProjectAssetUploadHandler();
