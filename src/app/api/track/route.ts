import path from "node:path";
import { stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyExport } from "@/lib/ffmpeg/verifyExport";
import { StableCenterFrameTracker } from "@/lib/tracking/StableCenterFrameTracker";
import { LocalSubjectTracker } from "@/lib/tracking/LocalSubjectTracker";
import {
  TrackerCommandExecutionError,
  TrackerCommandInvalidOutputError,
  TrackerCommandNotConfiguredError,
  TrackerCommandTimeoutError,
} from "@/lib/tracking/CommandSubjectDetectionEngine";
import {
  OpenCvEngineExecutionError,
  OpenCvEngineInvalidOutputError,
  OpenCvEngineTimeoutError,
} from "@/lib/tracking/OpenCvFaceDetectionEngine";
import { AutoSubjectDetectionEngine, SubjectDetectionUnavailableError } from "@/lib/tracking/AutoSubjectDetectionEngine";
import { LocalMediaFileNotFoundError } from "@/lib/transcript/transcriptHttp";
import type { FrameTracker } from "@/lib/tracking/types";

const KNOWN_PROVIDERS = ["local-subject", "stable-center-fallback"] as const;
type TrackProviderId = (typeof KNOWN_PROVIDERS)[number];

export type TrackerFactory = (providerId: TrackProviderId) => FrameTracker;

function defaultTrackerFactory(providerId: TrackProviderId): FrameTracker {
  if (providerId === "stable-center-fallback") {
    return new StableCenterFrameTracker();
  }
  // "local-subject" prefers a configured PEAKCUT_TRACKER_COMMAND, then falls
  // back to the local OpenCV face detector if available — see
  // AutoSubjectDetectionEngine. It never silently substitutes a centered
  // fallback for a real detection; see SubjectDetectionUnavailableError below.
  return new LocalSubjectTracker(new AutoSubjectDetectionEngine());
}

/**
 * Real crop-tracking endpoint. `sourcePath` must resolve strictly inside
 * the configured uploads directory (same defense-in-depth pattern as
 * /api/export-segment and /api/transcribe). The response never includes a
 * server filesystem path — only the resulting track (keyframes, method,
 * fallback_used) and per-keyframe confidence.
 */
export function createTrackHandler(deps: { uploadsBaseDir: string; trackerFactory?: TrackerFactory }) {
  const resolvedUploadsBase = path.resolve(deps.uploadsBaseDir);
  const trackerFactory = deps.trackerFactory ?? defaultTrackerFactory;

  return async function POST(request: NextRequest) {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    if (typeof json !== "object" || json === null) {
      return NextResponse.json({ ok: false, error: "Le corps de la requête doit être un objet." }, { status: 400 });
    }
    const body = json as Record<string, unknown>;

    if (typeof body.sourcePath !== "string" || body.sourcePath.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "sourcePath est requis." }, { status: 400 });
    }
    if (body.sourcePath.includes("..")) {
      return NextResponse.json(
        { ok: false, error: "sourcePath ne doit pas contenir de séquence de parcours de chemin." },
        { status: 400 }
      );
    }
    if (typeof body.provider !== "string" || !KNOWN_PROVIDERS.includes(body.provider as TrackProviderId)) {
      return NextResponse.json(
        { ok: false, error: `provider inconnu. Attendu : ${KNOWN_PROVIDERS.join(", ")}.` },
        { status: 400 }
      );
    }
    const providerId = body.provider as TrackProviderId;

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

    const probed = await verifyExport(resolvedSource);
    const tracker = trackerFactory(providerId);

    try {
      const track = await tracker.track({
        sourceWidth: probed.width ?? 0,
        sourceHeight: probed.height ?? 0,
        durationSec: probed.durationSec,
        mediaPath: resolvedSource,
      });

      return NextResponse.json(
        {
          ok: true,
          provider: providerId,
          track: {
            keyframes: track.keyframes.map((k) => ({
              t_sec: k.tSec,
              cx: k.cx,
              cy: k.cy,
              confidence: k.confidence,
            })),
            fallback_used: track.fallbackUsed,
            method: track.method,
          },
        },
        { status: 200 }
      );
    } catch (err) {
      if (err instanceof TrackerCommandNotConfiguredError || err instanceof SubjectDetectionUnavailableError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
      }
      if (err instanceof LocalMediaFileNotFoundError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 404 });
      }
      if (err instanceof TrackerCommandTimeoutError || err instanceof OpenCvEngineTimeoutError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 504 });
      }
      if (
        err instanceof TrackerCommandExecutionError ||
        err instanceof TrackerCommandInvalidOutputError ||
        err instanceof OpenCvEngineExecutionError ||
        err instanceof OpenCvEngineInvalidOutputError
      ) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
      }
      return NextResponse.json({ ok: false, error: "Erreur interne lors du suivi de cadrage." }, { status: 500 });
    }
  };
}

const defaultUploadsDir = path.join(process.cwd(), ".data", "uploads");

export const POST = createTrackHandler({ uploadsBaseDir: defaultUploadsDir });
