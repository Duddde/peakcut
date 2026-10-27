import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createFixedWindowRateLimiter, type RateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getRequestActorAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import {
  getSharedPublicTrialRateLimiters,
  tooManyRequests,
  type PublicTrialRateLimiters,
} from "@/lib/publicTrial/quotas";
import { drawtextFontFragment, renderPreviewSegment } from "@/lib/ffmpeg/renderPreviewSegment";
import { SqliteAssetRepository } from "@/lib/assets/AssetRepository";
import { defaultAssetsBaseDir } from "@/lib/assets/assetStore";
import { resolveOverlayFiles } from "@/lib/assets/resolveOverlayFiles";
import type { NormalizedRect, Segment, TranscriptWord } from "@/lib/domain/types";
import { parseSegmentInput, ProjectInputParseError } from "@/lib/db/parseProjectInput";
import type { RenderPlan } from "@/lib/effects/types";

const execFileAsync = promisify(execFile);
const MAX_DURATION_SEC = 15;
/**
 * An account previews the whole clip, not a teaser: it is how the edit is
 * checked before (or instead of) a full render. The cap sits above the
 * longest clip the cutter proposes (IDEAL_MAX_SEC, 95 s) and only bounds a
 * hand-stretched one.
 */
export const ACCOUNT_PREVIEW_MAX_DURATION_SEC = 120;
/** Applies to a caller-supplied upload path only; a project's own source is the server's file. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface PreviewHandlerOptions {
  uploadsBaseDir: string;
  previewsBaseDir: string;
  rateLimiter?: RateLimiter;
  enabled?: boolean;
  /** Where the worker writes downloaded YouTube sources; a project preview may read from it too. */
  downloadsBaseDir?: string;
  /** Root of the illustration store; defaults to the PEAKCUT_ASSETS_DIR convention. */
  assetsBaseDir?: string;
  appDeps?: AppDeps;
  trialRateLimiters?: PublicTrialRateLimiters;
}

function clientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

function safePath(value: unknown, baseDir: string): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  const base = path.resolve(baseDir);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function probeDuration(sourcePath: string): Promise<number> {
  const result = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath], { timeout: 30_000 });
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid duration");
  return duration;
}

/**
 * Resolves a project-scoped preview request (`{ projectId, segmentId }`):
 * the caller — an account, or a public-trial actor when
 * PEAKCUT_PUBLIC_TRIAL=1 — must own the project (404 otherwise, like every
 * project route). A trial previews the segment's start plus at most
 * MAX_DURATION_SEC, and is additionally capped per window; an account
 * previews the whole segment, up to ACCOUNT_PREVIEW_MAX_DURATION_SEC.
 *
 * `segment` may carry the studio's current, unsaved version of the clip
 * (bounds, words, framing, effects), so that the preview follows the edit
 * without a save first. It only ever replaces *what* is rendered: the
 * media still comes from the project's own source, and illustrations are
 * still resolved among this project's assets.
 */
interface ProjectPreview {
  sourcePath: string;
  startSec: number;
  endSec: number;
  /** The longest window this caller may preview. */
  maxDurationSec: number;
  /** The variant's framing — what makes the preview vertical and on the speaker. */
  crop?: NormalizedRect;
  words: TranscriptWord[];
  renderPlan?: RenderPlan;
  /** The plan's illustrations, already resolved to files of this project. */
  overlayFiles: Record<string, string>;
}

/** The variant the caller asked for, else the segment's first. */
function pickVariant(segment: Segment, variantId: unknown) {
  if (typeof variantId === "string") {
    const match = segment.variants.find((v) => v.id === variantId);
    if (match) return match;
  }
  return segment.variants[0];
}

async function resolveProjectPreview(
  request: NextRequest,
  body: Record<string, unknown>,
  options: PreviewHandlerOptions
): Promise<ProjectPreview | NextResponse> {
  const depsOrError = resolveRouteDeps(options.appDeps);
  if (depsOrError instanceof NextResponse) return depsOrError;
  const deps = depsOrError;

  const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
  if (!actor) return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });

  const projectId = body.projectId as string;
  const repo = new SqliteProjectRepository(deps.db);
  const ownerId = repo.getProjectOwnerId(projectId);
  const project = ownerId !== null && ownerId === actor.user.id ? repo.getProjectById(projectId) : null;
  if (!project) return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });

  let segment: Segment | undefined;
  if (body.segment !== undefined) {
    try {
      segment = parseSegmentInput(body.segment);
    } catch (err) {
      if (err instanceof ProjectInputParseError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
      }
      throw err;
    }
  } else {
    segment = project.segments.find((s) => s.id === body.segmentId);
  }
  if (!segment) return NextResponse.json({ ok: false, error: "Segment introuvable." }, { status: 404 });

  const localPath = project.source.localFilePath;
  const sourcePath =
    safePath(localPath, options.uploadsBaseDir) ??
    (options.downloadsBaseDir ? safePath(localPath, options.downloadsBaseDir) : null);
  if (!sourcePath) {
    return NextResponse.json({ ok: false, error: "Aucun média disponible pour ce projet." }, { status: 422 });
  }

  if (actor.kind === "trial") {
    const limited = (options.trialRateLimiters ?? getSharedPublicTrialRateLimiters()).previews.consume(
      `trial-previews:${actor.user.id}`
    );
    if (!limited.allowed) {
      return tooManyRequests("Limite d'aperçus de l'essai public atteinte. Réessayez plus tard.", limited.retryAfterMs);
    }
  }

  const maxDurationSec = actor.kind === "trial" ? MAX_DURATION_SEC : ACCOUNT_PREVIEW_MAX_DURATION_SEC;
  return {
    sourcePath,
    startSec: segment.startSec,
    endSec: Math.min(segment.endSec, segment.startSec + maxDurationSec),
    maxDurationSec,
    crop: pickVariant(segment, body.variantId)?.crop,
    words: segment.words,
    renderPlan: segment.renderPlan ?? undefined,
    overlayFiles: resolveOverlayFiles(segment.renderPlan, project.id, {
      repo: new SqliteAssetRepository(deps.db),
      baseDir: options.assetsBaseDir ?? defaultAssetsBaseDir(),
    }),
  };
}

export function createPreviewSegmentHandler(options: PreviewHandlerOptions) {
  const rateLimiter = options.rateLimiter ?? createFixedWindowRateLimiter({ maxRequests: 10, windowMs: 60_000 });
  return async function POST(request: NextRequest) {
    if (options.enabled === false) return NextResponse.json({ ok: false, fallback: "browser", error: "Aperçu serveur désactivé." }, { status: 503 });
    const limited = rateLimiter.consume(clientKey(request));
    if (!limited.allowed) {
      const response = NextResponse.json({ ok: false, error: "Trop de demandes d'aperçu." }, { status: 429 });
      if (limited.retryAfterMs) response.headers.set("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      return response;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object") throw new Error("object required");
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ ok: false, error: "Corps JSON invalide." }, { status: 400 });
    }
    let sourcePath: string | null;
    let startSec: number | null;
    let endSec: number | null;
    let projectPreview: ProjectPreview | null = null;
    if (typeof body.projectId === "string") {
      // Project mode: the source comes from the caller's own project in
      // the DB, never from the request body.
      const resolved = await resolveProjectPreview(request, body, options);
      if (resolved instanceof NextResponse) return resolved;
      projectPreview = resolved;
      ({ sourcePath, startSec, endSec } = resolved);
    } else {
      sourcePath = safePath(body.sourcePath, options.uploadsBaseDir);
      if (!sourcePath) return NextResponse.json({ ok: false, error: "Source hors du répertoire uploads." }, { status: 403 });
      startSec = numberValue(body.startSec);
      endSec = numberValue(body.endSec);
    }
    if (startSec === null || endSec === null || startSec < 0 || endSec <= startSec) {
      return NextResponse.json({ ok: false, error: "Bornes d'aperçu invalides." }, { status: 400 });
    }
    const maxDurationSec = projectPreview?.maxDurationSec ?? MAX_DURATION_SEC;
    if (endSec - startSec > maxDurationSec) return NextResponse.json({ ok: false, error: `L'aperçu est limité à ${maxDurationSec} secondes.` }, { status: 422 });
    let sourceInfo;
    try {
      sourceInfo = await stat(sourcePath);
      // A downloaded video easily weighs several hundred MB, and the
      // preview only seeks into it: the size cap guards uploads alone.
      const tooLarge = !projectPreview && sourceInfo.size > MAX_FILE_BYTES;
      if (!sourceInfo.isFile() || tooLarge) return NextResponse.json({ ok: false, error: "Média invalide ou trop volumineux." }, { status: 422 });
    } catch {
      return NextResponse.json({ ok: false, error: "Média source introuvable." }, { status: 404 });
    }
    try {
      const duration = await probeDuration(sourcePath);
      if (endSec > duration + 0.05) return NextResponse.json({ ok: false, error: "La fin de l'aperçu dépasse la durée réelle du média." }, { status: 422 });
      await mkdir(options.previewsBaseDir, { recursive: true });
      const previewId = randomUUID();
      const outputPath = path.join(options.previewsBaseDir, `${previewId}.mp4`);
      let assPath: string | null = null;

      if (projectPreview) {
        // A project preview has to show the edit, not the raw source: the
        // variant's framing, the plan's zoom and the burned-in captions —
        // the same pipeline as the export, at preview resolution and
        // watermarked. Previewing a letterboxed crop of the original made
        // every framing and effect decision invisible until download.
        ({ assPath } = await renderPreviewSegment({
          inputMediaPath: sourcePath,
          startSec,
          endSec,
          outputPath,
          crop: projectPreview.crop,
          words: projectPreview.words,
          renderPlan: projectPreview.renderPlan,
          overlayFiles: projectPreview.overlayFiles,
          maxDurationSec: projectPreview.maxDurationSec,
        }));
      } else {
        // drawtext needs a real font file: left to fontconfig, it segfaults
        // on an ffmpeg build without a fontconfig configuration (Windows).
        const videoFilter =
          "scale=540:-2:force_original_aspect_ratio=decrease," +
          "pad=540:960:(ow-iw)/2:(oh-ih)/2:black," +
          `drawtext=${drawtextFontFragment()}text='PeakCut Apercu':x=(w-text_w)/2:y=h-70:` +
          "fontsize=28:fontcolor=white@0.82:box=1:boxcolor=black@0.45:boxborderw=8";
        await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startSec), "-i", sourcePath, "-t", String(endSec - startSec), "-vf", videoFilter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", outputPath], { timeout: 90_000 });
      }

      if ((await stat(outputPath)).size <= 0) throw new Error("empty output");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      setTimeout(() => {
        void unlink(outputPath).catch(() => undefined);
        if (assPath) void unlink(assPath).catch(() => undefined);
      }, 15 * 60 * 1000).unref();
      return NextResponse.json({ ok: true, previewId, url: `/api/preview-segment/${previewId}`, expiresAt, durationSec: endSec - startSec, watermark: true }, { status: 201 });
    } catch {
      return NextResponse.json({ ok: false, error: "Aperçu indisponible pour ce média." }, { status: 422 });
    }
  };
}

const defaultHandler = createPreviewSegmentHandler({
  uploadsBaseDir: process.env.PEAKCUT_UPLOADS_DIR ?? path.join(process.cwd(), ".data", "uploads"),
  previewsBaseDir: process.env.PEAKCUT_PREVIEW_DIR ?? path.join(process.cwd(), ".data", "previews"),
  downloadsBaseDir: process.env.PEAKCUT_DOWNLOADS_DIR ?? path.join(process.cwd(), ".data", "downloads"),
});

export const POST = defaultHandler;
