"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Source, WorkflowState } from "@/lib/domain/types";
import { parseIngestResponse } from "@/lib/ingestion/parseIngestResponse";

/**
 * Lets a user pick a local media file, preview it in the browser (HTML5
 * <video>/<audio>, no upload involved yet), and then explicitly import it
 * via a real multipart POST to /api/ingest-media. Only bytes the user
 * already has on this machine ever get sent here; fetching a YouTube
 * source is the separate YoutubeSourcePanel path.
 */

const ACCEPTED_TYPES =
  "video/mp4,video/quicktime,video/webm,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/wave,audio/mp4,audio/x-m4a";

type UploadStatus = "idle" | "uploading" | "success" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function SourceIngestPanel({
  onIngested,
  projectId,
}: {
  onIngested: (result: { source: Source; workflow: WorkflowState }) => void;
  /**
   * When provided (i.e. the studio is mounted on a persisted project, not
   * the public demo), the import is associated with this project and its
   * `source` is persisted immediately server-side — see /api/ingest-media.
   * Omitted entirely on the public landing-page demo, which stays
   * anonymous and unauthenticated exactly as before.
   */
  projectId?: string;
}) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setFile(selected);
    setStatus("idle");
    setStatusMessage(null);

    if (selected) {
      const url = URL.createObjectURL(selected);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  }

  async function handleImport() {
    if (!file) return;
    setStatus("uploading");
    setStatusMessage("Import en cours…");

    try {
      const formData = new FormData();
      formData.set("file", file);
      if (projectId) {
        formData.set("projectId", projectId);
      }
      const res = await fetch("/api/ingest-media", { method: "POST", body: formData });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setStatus("error");
        setStatusMessage(json?.error ?? "L'import a échoué.");
        return;
      }

      const parsed = parseIngestResponse(json);
      setStatus("success");
      setStatusMessage(
        `Import réussi : "${parsed.source.title}" (${parsed.source.durationSec.toFixed(1)}s détectées).`
      );
      onIngested(parsed);
    } catch {
      setStatus("error");
      setStatusMessage("Impossible de contacter le serveur d'import. Réessayez.");
    }
  }

  const isVideo = file?.type.startsWith("video/") ?? true;

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Média local</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Sélectionnez un fichier vidéo ou audio sur cette machine. Rien n&apos;est téléchargé
          depuis Internet par ce panneau — pour une source YouTube, utilisez le panneau « Source
          YouTube » ci-dessous.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition hover:border-amber-400/60 focus-within:ring-2 focus-within:ring-amber-400/50"
        >
          Choisir un fichier local
          <input
            id={inputId}
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={handleFileChange}
            className="sr-only"
          />
        </label>

        <button
          type="button"
          onClick={handleImport}
          disabled={!file || status === "uploading"}
          className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "uploading" ? "Import…" : "Importer"}
        </button>
      </div>

      {file && (
        <div className="space-y-3 rounded-lg border border-white/10 bg-black/20 p-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
            <dt className="text-zinc-600">Nom</dt>
            <dd className="truncate text-zinc-200">{file.name}</dd>
            <dt className="text-zinc-600">Type</dt>
            <dd className="text-zinc-200">{file.type || "inconnu"}</dd>
            <dt className="text-zinc-600">Taille</dt>
            <dd className="text-zinc-200">{formatBytes(file.size)}</dd>
          </dl>

          {previewUrl &&
            (isVideo ? (
              <video
                data-testid="media-preview"
                src={previewUrl}
                controls
                className="max-h-64 w-full rounded-lg bg-black"
              />
            ) : (
              <audio data-testid="media-preview" src={previewUrl} controls className="w-full" />
            ))}
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        aria-label="Statut de l'import"
        className={`text-xs ${
          status === "error"
            ? "text-rose-300"
            : status === "success"
              ? "text-emerald-300"
              : "text-zinc-500"
        }`}
      >
        {statusMessage}
      </p>
    </div>
  );
}
