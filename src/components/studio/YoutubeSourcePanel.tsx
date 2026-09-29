"use client";

import { useEffect, useId, useRef, useState } from "react";
import { parseJobResponse, type ParsedJob } from "@/lib/jobs/parseJobResponse";
import { pollJobUntilDone } from "@/lib/jobs/jobClient";
import { JobProgress } from "./JobProgress";

/**
 * Submits a YouTube URL, which the server validates and then downloads in
 * the background so the video can be fed to the rest of the pipeline.
 *
 * The download runs as a queued job, never inside the request: a full
 * video takes minutes. This panel enqueues it and then polls, showing real
 * server-reported progress — it never fakes a progress bar for work that
 * isn't happening, and a job that fails says so with the server's own
 * reason.
 *
 * Only the *validated* URL leaves the browser, and downloading a source
 * unlocks nothing: the rights confirmation and export authorization are
 * still required afterwards, exactly as for a local import.
 */

type DownloadStatus = "idle" | "working" | "success" | "error";

/** True when JobProgress is already showing this exact message, so the panel must not repeat it. */
function shownByJobProgress(job: ParsedJob | null, message: string | null): boolean {
  return message !== null && job?.errorMessage === message;
}

export function YoutubeSourcePanel({
  projectId,
  onDownloaded,
}: {
  /**
   * The persisted project the downloaded video becomes the source of.
   * Omitted on the anonymous public demo, where the panel explains that a
   * project is needed rather than offering a download nobody owns.
   */
  projectId?: string;
  /** Called once the download job has succeeded, so the caller can reload the project. */
  onDownloaded?: (job: ParsedJob) => void;
}) {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<ParsedJob | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || status === "working") return;

    setStatus("working");
    setMessage("Validation du lien…");
    setJob(null);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    let queued: ParsedJob;
    try {
      const res = await fetch("/api/download-youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, projectId }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setStatus("error");
        setMessage(typeof json?.error === "string" ? json.error : "Le téléchargement n'a pas pu être lancé.");
        return;
      }
      queued = parseJobResponse(json);
    } catch {
      setStatus("error");
      setMessage("Impossible de contacter le serveur. Réessayez.");
      return;
    }

    setJob(queued);
    setMessage("Lien validé. Téléchargement de la vidéo en cours…");

    try {
      const finished = await pollJobUntilDone(queued.id, {
        signal: controller.signal,
        onUpdate: setJob,
      });
      setJob(finished);

      if (finished.status !== "succeeded") {
        setStatus("error");
        setMessage(finished.errorMessage ?? "Le téléchargement a échoué.");
        return;
      }

      setStatus("success");
      setMessage("Vidéo téléchargée et associée au projet.");
      onDownloaded?.(finished);
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "Le suivi du téléchargement s'est interrompu — le job continue peut-être en arrière-plan."
      );
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Source YouTube</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Collez le lien d&apos;une vidéo unique. PeakCut vérifie le lien, télécharge la vidéo sur le
          serveur, puis la soumet au reste du traitement. N&apos;importez que des contenus dont vous
          détenez les droits : l&apos;export restera bloqué tant que vous ne les aurez pas confirmés.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row" noValidate>
        <label htmlFor={inputId} className="sr-only">
          Lien YouTube à télécharger
        </label>
        <input
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-invalid={status === "error"}
          className="w-full flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none ring-amber-400/50 transition focus:border-amber-400/60 focus:ring-2"
        />
        <button
          type="submit"
          disabled={!projectId || status === "working" || url.trim().length === 0}
          className="shrink-0 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "working" ? "Téléchargement…" : "Valider et télécharger"}
        </button>
      </form>

      {!projectId && (
        <p className="text-xs text-zinc-500">
          Le téléchargement s&apos;effectue dans un projet enregistré : créez ou ouvrez un projet
          pour l&apos;utiliser.
        </p>
      )}

      <JobProgress label="téléchargement YouTube" job={job} />

      <p
        role="status"
        aria-live="polite"
        aria-label="Statut du téléchargement YouTube"
        className={`text-xs ${
          status === "error" ? "text-rose-300" : status === "success" ? "text-emerald-300" : "text-zinc-500"
        }`}
      >
        {shownByJobProgress(job, message) ? null : message}
      </p>
    </div>
  );
}
