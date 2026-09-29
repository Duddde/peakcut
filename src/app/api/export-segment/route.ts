import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { exportSegment } from "@/lib/ffmpeg/exportSegment";
import { verifyExport } from "@/lib/ffmpeg/verifyExport";
import { parseExportRequestBody, ExportRequestParseError } from "@/lib/ffmpeg/parseExportRequest";
import { getExportBlockReasons } from "@/lib/workflow/exportGate";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";

/**
 * Real export endpoint: cuts a vertical (1080x1920) H.264/AAC clip with
 * burned-in word-by-word subtitles from the project's media file — a
 * local import or a downloaded YouTube source — via the real ffmpeg
 * binary, then verifies the result with real ffprobe.
 *
 * This is the *final, full-quality* download — unlike the free, anonymous
 * /api/preview-segment (low-res, watermarked, no account needed), this
 * route requires an authenticated session. The landing page's own
 * "Télécharger" button already gates on this client-side (AccountGate),
 * but that is only a UX nicety — this check is what actually enforces it,
 * since a client-side gate alone is trivially bypassed.
 *
 * Guardrails enforced here, independently of anything the UI already hid:
 * - the caller must be authenticated;
 * - the workflow must be in `export_authorized` phase with rights confirmed
 *   (see getExportBlockReasons) — checked again server-side, not just in
 *   the client;
 * - sourcePath must resolve strictly inside the configured uploads
 *   directory (defense against path traversal from a crafted request);
 * - the segment must fit within the real (ffprobe-measured) duration of
 *   the source file — the client-declared duration is never trusted.
 *
 * There is no publish/distribute step anywhere in this route.
 */
export function createExportSegmentHandler(
  deps: { uploadsBaseDir: string; exportsBaseDir: string },
  injectedAppDeps?: AppDeps
) {
  const resolvedUploadsBase = path.resolve(deps.uploadsBaseDir);

  return async function POST(request: NextRequest) {
    const appDepsOrError = resolveRouteDeps(injectedAppDeps);
    if (appDepsOrError instanceof NextResponse) return appDepsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, appDepsOrError);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Un compte est requis pour le téléchargement final. Connectez-vous puis réessayez." },
        { status: 401 }
      );
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    let body;
    try {
      body = parseExportRequestBody(json);
    } catch (err) {
      const message = err instanceof ExportRequestParseError ? err.message : "Requête invalide.";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const resolvedSource = path.resolve(body.sourcePath);
    if (!resolvedSource.startsWith(resolvedUploadsBase + path.sep)) {
      return NextResponse.json(
        { ok: false, error: "sourcePath est hors du répertoire d'upload autorisé." },
        { status: 403 }
      );
    }

    try {
      await stat(resolvedSource);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Le fichier source n'existe pas sur le serveur." },
        { status: 404 }
      );
    }

    const probedSource = await verifyExport(resolvedSource);

    const blockReasons = getExportBlockReasons({
      workflow: body.workflow,
      hasLocalMediaFile: true,
      segmentEndSec: body.endSec,
      sourceDurationSec: probedSource.durationSec,
    });
    if (blockReasons.length > 0) {
      return NextResponse.json({ ok: false, error: "Export refusé.", reasons: blockReasons }, { status: 403 });
    }

    const resolvedExportsBase = path.resolve(deps.exportsBaseDir);
    await mkdir(resolvedExportsBase, { recursive: true });
    const exportId = randomUUID();
    const outputPath = path.join(resolvedExportsBase, `${exportId}.mp4`);

    let exportResult;
    try {
      exportResult = await exportSegment({
        inputMediaPath: resolvedSource,
        startSec: body.startSec,
        endSec: body.endSec,
        outputPath,
        words: body.words,
        crop: body.crop,
        renderPlan: body.renderPlan,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Échec de l'export ffmpeg.";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }

    const verified = await verifyExport(outputPath);

    return NextResponse.json(
      {
        ok: true,
        output: {
          width: verified.width,
          height: verified.height,
          video_codec: verified.videoCodec,
          audio_codec: verified.audioCodec,
          duration_sec: verified.durationSec,
        },
        render_applied: {
          zoom: exportResult.renderApplied.zoom,
          subtitle_style: exportResult.renderApplied.subtitleStyle,
          ducking: exportResult.renderApplied.ducking,
          template_id: exportResult.renderApplied.templateId,
        },
        render_limitations: exportResult.renderLimitations,
        exported_at: new Date().toISOString(),
        export_id: exportId,
        note: "Fichier généré côté serveur (identifié par export_id) ; aucune publication n'a été déclenchée.",
      },
      { status: 201 }
    );
  };
}

const defaultUploadsDir = path.join(process.cwd(), ".data", "uploads");
const defaultExportsDir = path.join(process.cwd(), ".data", "exports");

export const POST = createExportSegmentHandler({
  uploadsBaseDir: defaultUploadsDir,
  exportsBaseDir: defaultExportsDir,
});
