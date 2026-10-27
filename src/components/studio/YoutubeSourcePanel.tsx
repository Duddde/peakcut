"use client";

import { useEffect, useId, useRef, useState } from "react";
import { parseJobResponse, type ParsedJob } from "@/lib/jobs/parseJobResponse";
import { followPipeline, pollJobUntilDone } from "@/lib/jobs/jobClient";
import { validateYoutubeUrl } from "@/lib/youtube/validateYoutubeUrl";
import { JobProgress } from "./JobProgress";
import {
  mergePipelineStep,
  PIPELINE_STEP_LABELS,
  PipelineSteps,
  plannedPipelineSteps,
  type PipelineStepView,
} from "./PipelineSteps";

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
 * still required afterwards (where the server asks for them), exactly as
 * for a local import.
 *
 * Given `pipeline`, the download is the first step of the whole automatic
 * pipeline — transcription, cutting, framing — and pasting a valid link
 * starts it on its own: no button to find, nothing else to click.
 */

type DownloadStatus = "idle" | "working" | "success" | "error";

/** True when JobProgress is already showing this exact message, so the panel must not repeat it. */
function shownByJobProgress(job: ParsedJob | null, message: string | null): boolean {
  return message !== null && job?.errorMessage === message;
}

export interface YoutubePipelineOptions {
  providerId: string;
  trackProvider?: string;
}

export function YoutubeSourcePanel({
  projectId,
  onDownloaded,
  requiresAccount = false,
  onAccountRequired,
  pipeline,
  autoSubmitUrl,
  withMotion = false,
}: {
  projectId?: string;
  /** Called once the video is on the server — and, with `pipeline`, once every step after it succeeded too. */
  onDownloaded?: (job: ParsedJob) => void;
  requiresAccount?: boolean;
  onAccountRequired?: () => void;
  /** Runs the whole automatic pipeline after the download. Absent, only the video is fetched. */
  pipeline?: YoutubePipelineOptions;
  /** A link to start on as soon as it is given (handed over by the projects list's paste box). */
  autoSubmitUrl?: string;
  /** Whether the server will close the pipeline with Claude Motion: only shown as a planned step then. */
  withMotion?: boolean;
}) {
  const inputId = useId();
  const [url, setUrl] = useState(autoSubmitUrl ?? "");
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<ParsedJob | null>(null);
  const [steps, setSteps] = useState<PipelineStepView[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const autoSubmitted = useRef(false);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(url);
  }

  /** A pasted link that is already valid needs no button press. */
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").trim();
    if (!validateYoutubeUrl(pasted).ok) return;
    event.preventDefault();
    setUrl(pasted);
    void submit(pasted);
  }

  async function submit(submittedUrl: string) {
    if (requiresAccount) {
      onAccountRequired?.();
      return;
    }
    if (!projectId || status === "working") return;

    setStatus("working");
    setMessage("Validation du lien…");
    setJob(null);
    setSteps(pipeline ? plannedPipelineSteps("download", { motion: withMotion }) : []);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    let queued: ParsedJob;
    try {
      const res = await fetch("/api/download-youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: submittedUrl, projectId, ...(pipeline ? { pipeline } : {}) }),
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

    if (pipeline) {
      setMessage("Lien validé. Traitement automatique en cours…");
      try {
        const ran = await followPipeline(projectId, queued, {
          signal: controller.signal,
          onStep: (current) => {
            setJob(current);
            setSteps((previous) => mergePipelineStep(previous, current));
          },
        });
        const failed = ran.find((step) => step.status !== "succeeded");
        if (failed) {
          setStatus("error");
          setMessage(
            `${PIPELINE_STEP_LABELS[failed.kind]} : ${failed.errorMessage ?? "étape interrompue"}. Les étapes suivantes n'ont pas été lancées.`
          );
          return;
        }
        setStatus("success");
        setMessage("Clips prêts : chargement du studio…");
        onDownloaded?.(ran[ran.length - 1]);
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus("error");
        setMessage(
          err instanceof Error
            ? err.message
            : "Le suivi du traitement s'est interrompu — il continue peut-être en arrière-plan."
        );
      }
      return;
    }

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

  // The projects list hands its pasted link over here. The studio passes
  // it only once it knows whether a full pipeline is possible (`pipeline`
  // set or not), so the run started here is the right one.
  useEffect(() => {
    if (!autoSubmitUrl || autoSubmitted.current || !projectId) return;
    autoSubmitted.current = true;
    void submit(autoSubmitUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmitUrl, projectId]);

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Source YouTube</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {pipeline
            ? "Collez le lien d'une vidéo unique : tout s'enchaîne aussitôt — téléchargement, transcription, découpage en clips, cadrage — jusqu'à l'aperçu du meilleur clip."
            : "Collez le lien d'une vidéo unique. PeakCut vérifie le lien, télécharge la vidéo sur le serveur, puis la soumet au reste du traitement."}{" "}
          N&apos;importez que des contenus dont vous détenez les droits.
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
          onPaste={handlePaste}
          aria-invalid={status === "error"}
          className="w-full flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none ring-amber-400/50 transition focus:border-amber-400/60 focus:ring-2"
        />
        <button
          type="submit"
          disabled={(!projectId && !requiresAccount) || status === "working" || url.trim().length === 0}
          className="shrink-0 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "working"
            ? pipeline
              ? "Traitement…"
              : "Téléchargement…"
            : requiresAccount
              ? "Se connecter pour télécharger"
              : pipeline
                ? "Lancer"
                : "Valider et télécharger"}
        </button>
      </form>

      {!projectId && (
        <p className="text-xs text-zinc-500">
          Le téléchargement s&apos;effectue dans un projet enregistré : créez ou ouvrez un projet
          pour l&apos;utiliser.
        </p>
      )}

      {pipeline ? <PipelineSteps steps={steps} /> : <JobProgress label="téléchargement YouTube" job={job} />}

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
