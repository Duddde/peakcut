import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createFixedWindowRateLimiter, type RateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";

const execFileAsync = promisify(execFile);
const MAX_DURATION_SEC = 15;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface PreviewHandlerOptions {
  uploadsBaseDir: string;
  previewsBaseDir: string;
  rateLimiter?: RateLimiter;
  enabled?: boolean;
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
    const sourcePath = safePath(body.sourcePath, options.uploadsBaseDir);
    if (!sourcePath) return NextResponse.json({ ok: false, error: "Source hors du répertoire uploads." }, { status: 403 });
    const startSec = numberValue(body.startSec);
    const endSec = numberValue(body.endSec);
    if (startSec === null || endSec === null || startSec < 0 || endSec <= startSec) {
      return NextResponse.json({ ok: false, error: "Bornes d'aperçu invalides." }, { status: 400 });
    }
    if (endSec - startSec > MAX_DURATION_SEC) return NextResponse.json({ ok: false, error: "L'aperçu gratuit est limité à 15 secondes." }, { status: 422 });
    let sourceInfo;
    try {
      sourceInfo = await stat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.size > MAX_FILE_BYTES) return NextResponse.json({ ok: false, error: "Média invalide ou trop volumineux." }, { status: 422 });
    } catch {
      return NextResponse.json({ ok: false, error: "Média source introuvable." }, { status: 404 });
    }
    try {
      const duration = await probeDuration(sourcePath);
      if (endSec > duration + 0.05) return NextResponse.json({ ok: false, error: "La fin de l'aperçu dépasse la durée réelle du média." }, { status: 422 });
      await mkdir(options.previewsBaseDir, { recursive: true });
      const previewId = randomUUID();
      const outputPath = path.join(options.previewsBaseDir, `${previewId}.mp4`);
      await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startSec), "-i", sourcePath, "-t", String(endSec - startSec), "-vf", "scale=540:-2:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='PeakCut Apercu':x=(w-text_w)/2:y=h-70:fontsize=28:fontcolor=white@0.82:box=1:boxcolor=black@0.45:boxborderw=8", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", outputPath], { timeout: 90_000 });
      if ((await stat(outputPath)).size <= 0) throw new Error("empty output");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      setTimeout(() => void unlink(outputPath).catch(() => undefined), 15 * 60 * 1000).unref();
      return NextResponse.json({ ok: true, previewId, url: `/api/preview-segment/${previewId}`, expiresAt, durationSec: endSec - startSec, watermark: true }, { status: 201 });
    } catch {
      return NextResponse.json({ ok: false, error: "Aperçu indisponible pour ce média." }, { status: 422 });
    }
  };
}

const defaultHandler = createPreviewSegmentHandler({
  uploadsBaseDir: process.env.PEAKCUT_UPLOADS_DIR ?? path.join(process.cwd(), ".data", "uploads"),
  previewsBaseDir: process.env.PEAKCUT_PREVIEW_DIR ?? path.join(process.cwd(), ".data", "previews"),
});

export const POST = defaultHandler;
