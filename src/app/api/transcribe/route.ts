import path from "node:path";
import { stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { listTranscriptProviders } from "@/lib/transcript/registry";
import type { TranscriptProvider } from "@/lib/transcript/TranscriptProvider";
import { TranscriptProviderNotConfiguredError } from "@/lib/transcript/TranscriptProvider";
import {
  LocalMediaFileNotFoundError,
  TranscriptHttpError,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
} from "@/lib/transcript/transcriptHttp";

/**
 * Real transcription endpoint. Accepts a `providerId` (from the registry —
 * "mock-deterministic", "openai-gpt-4o-transcribe-diarize", or
 * "assemblyai") and a `sourcePath` that MUST resolve strictly inside the
 * configured uploads directory (defense against path traversal from a
 * crafted request, same pattern as /api/export-segment).
 *
 * There is no silent fallback: an unconfigured real provider fails with a
 * clear 503, never by quietly substituting the mock or another provider.
 */
export function createTranscribeHandler(deps: { uploadsBaseDir: string; providers?: TranscriptProvider[] }) {
  const resolvedUploadsBase = path.resolve(deps.uploadsBaseDir);

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

    if (typeof body.providerId !== "string" || typeof body.sourcePath !== "string" || body.sourcePath.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "Les champs 'providerId' et 'sourcePath' sont requis." },
        { status: 400 }
      );
    }
    if (body.sourcePath.includes("..")) {
      return NextResponse.json(
        { ok: false, error: "sourcePath ne doit pas contenir de séquence de parcours de chemin." },
        { status: 400 }
      );
    }

    const providers = deps.providers ?? listTranscriptProviders();
    const provider = providers.find((p) => p.id === body.providerId);
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: `Fournisseur de transcription inconnu : "${body.providerId}".` },
        { status: 400 }
      );
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

    const languageHint = typeof body.languageHint === "string" ? body.languageHint : undefined;

    try {
      const transcript = await provider.transcribe({ mediaPath: resolvedSource, languageHint });
      return NextResponse.json({
        ok: true,
        provider_id: provider.id,
        transcript: {
          language: transcript.language,
          words: transcript.words.map((w) => ({
            text: w.text,
            start_sec: w.startSec,
            end_sec: w.endSec,
            speaker: w.speaker ?? null,
            confidence: w.confidence,
          })),
        },
      });
    } catch (err) {
      if (err instanceof TranscriptProviderNotConfiguredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
      }
      if (err instanceof LocalMediaFileNotFoundError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 404 });
      }
      if (err instanceof TranscriptTimeoutError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 504 });
      }
      if (err instanceof TranscriptHttpError || err instanceof TranscriptInvalidPayloadError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
      }
      return NextResponse.json(
        { ok: false, error: "Erreur interne lors de la transcription." },
        { status: 500 }
      );
    }
  };
}

const defaultUploadsDir = path.join(process.cwd(), ".data", "uploads");

export const POST = createTranscribeHandler({ uploadsBaseDir: defaultUploadsDir });
