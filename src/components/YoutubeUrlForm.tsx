"use client";

import { useEffect, useRef, useState } from "react";
import { parseJobResponse, type ParsedJob } from "@/lib/jobs/parseJobResponse";
import { pollJobUntilDone } from "@/lib/jobs/jobClient";
import { JobProgress } from "@/components/studio/JobProgress";
import { AccountGate } from "@/components/AccountGate";

/**
 * The landing page's single entry point: one button validates the pasted
 * link and then actually downloads the video so it can be fed to the rest
 * of the pipeline.
 *
 * The chain is validate → create a project → queue the download → poll it.
 * The download runs as a background job, never inside a request, so what
 * this component shows is real server-reported progress; it never animates
 * a bar for work that isn't happening.
 *
 * Downloading writes a file to the server on the user's behalf, so it
 * belongs to an account and to one of that account's projects — an
 * anonymous visitor gets the existing AccountGate instead, and the server
 * enforces this independently on /api/download-youtube.
 */

/** True when JobProgress is already showing this exact message, so the form must not repeat it. */
function shownByJobProgress(job: ParsedJob | null, message: string): boolean {
  return job?.errorMessage === message;
}

type FormState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "preparing" }
  | { status: "downloading"; videoId: string }
  | { status: "success"; videoId: string; projectId: string }
  | { status: "error"; error: string };

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json = await response.json();
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorFrom(json: Record<string, unknown> | null, fallback: string): string {
  return typeof json?.error === "string" ? json.error : fallback;
}

export function YoutubeUrlForm() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<FormState>({ status: "idle" });
  const [job, setJob] = useState<ParsedJob | null>(null);
  const [accountGateOpen, setAccountGateOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const busy =
    state.status === "validating" || state.status === "preparing" || state.status === "downloading";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    setJob(null);
    setAccountGateOpen(false);
    setState({ status: "validating" });

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    // 1. Structural validation, so a playlist/channel/bad host is rejected
    //    with a precise reason before an account or a project is involved.
    let videoId: string;
    try {
      const res = await fetch("/api/validate-youtube-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await readJson(res);
      if (!res.ok || json?.ok !== true || typeof json.videoId !== "string") {
        setState({ status: "error", error: errorFrom(json, "URL invalide.") });
        return;
      }
      videoId = json.videoId;
    } catch {
      setState({ status: "error", error: "Impossible de contacter le serveur de validation." });
      return;
    }

    // 2. A downloaded video has to land somewhere the user owns.
    setState({ status: "preparing" });
    let projectId: string;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `YouTube ${videoId}` }),
      });
      if (res.status === 401) {
        setAccountGateOpen(true);
        setState({ status: "idle" });
        return;
      }
      const json = await readJson(res);
      const project = json?.project as { id?: unknown } | undefined;
      if (!res.ok || json?.ok !== true || typeof project?.id !== "string") {
        setState({ status: "error", error: errorFrom(json, "Impossible de créer le projet.") });
        return;
      }
      projectId = project.id;
    } catch {
      setState({ status: "error", error: "Impossible de contacter le serveur." });
      return;
    }

    // 3. Queue the real download.
    let queued: ParsedJob;
    try {
      const res = await fetch("/api/download-youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, projectId }),
      });
      if (res.status === 401) {
        setAccountGateOpen(true);
        setState({ status: "idle" });
        return;
      }
      const json = await readJson(res);
      if (!res.ok || json?.ok !== true) {
        setState({ status: "error", error: errorFrom(json, "Le téléchargement n'a pas pu être lancé.") });
        return;
      }
      queued = parseJobResponse(json);
    } catch {
      setState({ status: "error", error: "Impossible de contacter le serveur de téléchargement." });
      return;
    }

    setJob(queued);
    setState({ status: "downloading", videoId });

    // 4. Follow the job to its real conclusion.
    try {
      const finished = await pollJobUntilDone(queued.id, {
        signal: controller.signal,
        onUpdate: setJob,
      });
      setJob(finished);
      if (finished.status !== "succeeded") {
        setState({ status: "error", error: finished.errorMessage ?? "Le téléchargement a échoué." });
        return;
      }
      setState({ status: "success", videoId, projectId });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        error:
          err instanceof Error
            ? err.message
            : "Le suivi du téléchargement s'est interrompu — le job continue peut-être en arrière-plan.",
      });
    }
  }

  const buttonLabel =
    state.status === "validating"
      ? "Vérification…"
      : state.status === "preparing"
        ? "Préparation…"
        : state.status === "downloading"
          ? "Téléchargement…"
          : "Valider et télécharger";

  return (
    <div className="w-full max-w-xl">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row" noValidate>
        <label htmlFor="youtube-url" className="sr-only">
          Lien YouTube public
        </label>
        <input
          id="youtube-url"
          type="url"
          required
          inputMode="url"
          autoComplete="off"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            if (pasted) {
              e.preventDefault();
              setUrl(pasted);
              setState({ status: "idle" });
              setJob(null);
            }
          }}
          aria-invalid={state.status === "error"}
          aria-describedby="youtube-url-help youtube-url-result"
          className="w-full flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none ring-amber-400/50 transition focus:border-amber-400/60 focus:ring-2"
        />
        <button
          type="submit"
          disabled={busy || url.trim().length === 0}
          className="shrink-0 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </form>

      <p id="youtube-url-help" className="mt-2 text-xs text-zinc-500">
        Le lien est vérifié, puis la vidéo est téléchargée dans un nouveau projet pour être
        analysée. N&apos;utilisez que des contenus dont vous détenez les droits : rien n&apos;est
        jamais publié, et l&apos;export reste bloqué tant que vous ne les avez pas confirmés.
      </p>

      {job && (
        <div className="mt-3">
          <JobProgress label="téléchargement YouTube" job={job} />
        </div>
      )}

      <div id="youtube-url-result" role="status" aria-live="polite" className="mt-3">
        {state.status === "downloading" && (
          <p className="text-sm text-zinc-400">
            Lien validé (id vidéo <code className="font-mono">{state.videoId}</code>). Téléchargement
            de la vidéo en cours…
          </p>
        )}
        {state.status === "success" && (
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
            <p>
              Vidéo téléchargée (id vidéo <code className="font-mono">{state.videoId}</code>) et
              associée à un nouveau projet.
            </p>
            <a
              href={`/projects/${state.projectId}`}
              className="mt-3 inline-block rounded-lg border border-emerald-300/40 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-300/10"
            >
              Ouvrir le projet dans le studio →
            </a>
          </div>
        )}
        {state.status === "error" && !shownByJobProgress(job, state.error) && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-300">
            {state.error}
          </p>
        )}
      </div>

      {accountGateOpen && (
        <AccountGate
          callbackUrl="/"
          onClose={() => setAccountGateOpen(false)}
          title="Un compte est nécessaire pour télécharger une source"
          body="La vidéo est téléchargée dans un projet qui vous appartient, ce qui demande un compte PeakCut (connexion Google). Vous restez responsable de détenir les droits sur la source."
        />
      )}
    </div>
  );
}
