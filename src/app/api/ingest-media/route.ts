import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { ingestMedia, IngestionValidationError, type IngestMediaDeps } from "@/lib/ingestion/ingestMedia";
import { createLocalMediaStorage, type MediaStorage } from "@/lib/ingestion/mediaStorage";
import { verifyExport } from "@/lib/ffmpeg/verifyExport";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import type { AppDeps } from "@/lib/appDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import type { Project } from "@/lib/domain/types";

/**
 * Local media ingestion endpoint. Accepts a multipart/form-data upload with
 * a single `file` field. Validates filename/type/size, stores the bytes
 * locally, and best-effort probes the real duration with ffprobe. This
 * route never downloads anything from YouTube or any other remote source —
 * it only accepts bytes the client already has.
 *
 * When the form data also includes a `projectId` field, the import is
 * associated with that persisted project: the caller must be authenticated
 * and own the project (404 for both "not found" and "not owned", to avoid
 * leaking existence), and on success only the project's `source` and
 * `workflow` are replaced — segments/transcript/timeline/title are left
 * untouched so a new import never silently discards prior editing work. A
 * fresh workflow is written because rights confirmation/export authorization
 * applied to the previous source and must be re-established for the new one.
 * When `projectId` is absent, behavior is exactly the anonymous/public demo
 * path — no auth is required or performed.
 */
export function createIngestMediaHandler(
  storage: MediaStorage,
  deps: IngestMediaDeps = {},
  injectedAppDeps?: AppDeps
) {
  return async function POST(request: NextRequest) {
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
      return NextResponse.json(
        { ok: false, error: "Le champ 'file' est requis." },
        { status: 400 }
      );
    }

    const projectIdField = formData.get("projectId");
    const projectId =
      typeof projectIdField === "string" && projectIdField.trim().length > 0 ? projectIdField.trim() : null;

    let projectRepo: SqliteProjectRepository | null = null;
    let existingProject: Project | null = null;

    if (projectId) {
      const appDepsOrError = resolveRouteDeps(injectedAppDeps);
      if (appDepsOrError instanceof NextResponse) return appDepsOrError;
      const appDeps = appDepsOrError;

      const user = await getAuthenticatedUserFromRequestAsync(request, appDeps);
      if (!user) {
        return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
      }

      projectRepo = new SqliteProjectRepository(appDeps.db);
      const ownerId = projectRepo.getProjectOwnerId(projectId);
      if (ownerId === null || ownerId !== user.id) {
        return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
      }
      existingProject = projectRepo.getProjectById(projectId);
      if (!existingProject) {
        return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
      }
    }

    const data = Buffer.from(await file.arrayBuffer());

    try {
      const result = await ingestMedia({ filename: file.name, mimeType: file.type, data }, storage, deps);

      if (projectId && projectRepo && existingProject) {
        const updatedProject: Project = {
          ...existingProject,
          source: result.source,
          workflow: result.workflow,
          updatedAt: new Date().toISOString(),
        };
        projectRepo.updateProject(projectId, updatedProject);
      }

      return NextResponse.json({ ok: true, source: result.source, workflow: result.workflow }, { status: 201 });
    } catch (err) {
      if (err instanceof IngestionValidationError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 422 });
      }
      throw err;
    }
  };
}

const defaultUploadsDir = path.join(process.cwd(), ".data", "uploads");

export const POST = createIngestMediaHandler(createLocalMediaStorage(defaultUploadsDir), {
  probeDurationSec: async (storedPath) => (await verifyExport(storedPath)).durationSec,
});
