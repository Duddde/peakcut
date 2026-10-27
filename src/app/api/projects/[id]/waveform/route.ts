import { stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { readAudioEnvelope, type ReadAudioEnvelope } from "@/lib/ffmpeg/audioEnvelope";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Longest stretch one request may ask for: the trimmer's view around a clip, not a whole film. */
export const WAVEFORM_MAX_WINDOW_SEC = 300;
export const WAVEFORM_MAX_POINTS = 2000;

/**
 * The audio level of a stretch of the project's source, as `points`
 * values between 0 and 1 — what the clip trimmer draws, so that the pauses
 * between sentences can be seen and a cut put in one.
 *
 * Same ownership rule as every project route (404 for someone else's
 * project), and the media is always the project's own: the caller only
 * chooses the window, never a file.
 */
export function createWaveformHandler(injectedDeps?: AppDeps, readEnvelope: ReadAudioEnvelope = readAudioEnvelope) {
  return async function GET(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }

    const { id } = await context.params;
    const repo = new SqliteProjectRepository(deps.db);
    const ownerId = repo.getProjectOwnerId(id);
    const project = ownerId !== null && ownerId === user.id ? repo.getProjectById(id) : null;
    if (!project) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    const params = request.nextUrl.searchParams;
    const startSec = Number(params.get("startSec"));
    const endSec = Number(params.get("endSec"));
    const points = Number(params.get("points") ?? 600);
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      startSec < 0 ||
      endSec <= startSec ||
      endSec - startSec > WAVEFORM_MAX_WINDOW_SEC ||
      !Number.isInteger(points) ||
      points < 1 ||
      points > WAVEFORM_MAX_POINTS
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: `Fenêtre invalide : startSec < endSec, ${WAVEFORM_MAX_WINDOW_SEC} s au plus, points entre 1 et ${WAVEFORM_MAX_POINTS}.`,
        },
        { status: 400 }
      );
    }

    const mediaPath = project.source.localFilePath;
    if (!mediaPath || !(await stat(mediaPath).then((s) => s.isFile()).catch(() => false))) {
      return NextResponse.json({ ok: false, error: "Aucun média disponible pour ce projet." }, { status: 422 });
    }

    try {
      const envelope = await readEnvelope(mediaPath, startSec, endSec - startSec, (endSec - startSec) / points);
      const loudest = Math.max(...envelope.levels, 1e-6);
      return NextResponse.json({
        ok: true,
        startSec: envelope.startSec,
        frameSec: envelope.frameSec,
        // Normalized to the window's loudest moment: what matters on
        // screen is where the voice drops, not the recording's level.
        levels: envelope.levels.map((level) => Number((level / loudest).toFixed(3))),
      });
    } catch {
      return NextResponse.json({ ok: false, error: "Lecture audio impossible pour ce média." }, { status: 422 });
    }
  };
}

export const GET = createWaveformHandler();
