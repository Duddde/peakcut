"use client";

import { useEffect, useRef, useState } from "react";
import { parseJobResponse, type ParsedJob } from "@/lib/jobs/parseJobResponse";
import { pollJobUntilDone } from "@/lib/jobs/jobClient";
import { JobProgress } from "@/components/studio/JobProgress";
import { AccountGate } from "@/components/AccountGate";
import { PublicTrialNotice } from "@/components/PublicTrialNotice";
import {
  fetchPublicTrialStatus,
  formatTrialDuration,
  type PublicTrialLimitsSummary,
} from "@/lib/publicTrial/client";

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
 *
 * When the server runs the public trial (PEAKCUT_PUBLIC_TRIAL=1), a
 * signed-out visitor is instead offered an anonymous trial: right after
 * validation the trial status is asked (GET /api/public-trial), its limits
 * are shown, the visitor confirms holding the rights on the video, and only
 * then is the trial started (POST /api/public-trial) and the same chain —
 * create the (ephemeral) project, queue the download, poll — resumed.
 * No project creation is attempted before that, and no AccountGate is ever
 * opened on that path.
 *
 * Every network wait has its own visible message, so the button never
 * looks like it did nothing.
 */

/** True when JobProgress is already showing this exact message, so the form must not repeat it. */
function shownByJobProgress(job: ParsedJob | null, message: string): boolean {
  return job?.errorMessage === message;
}

type FormState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "checking-trial"; videoId: string }
  | { status: "preparing" }
  | { status: "downloading"; videoId: string }
  | { status: "validated"; videoId: string }
  | { status: "trial-offer"; videoId: string; limits: PublicTrialLimitsSummary }
  | { status: "starting-trial"; videoId: string; limits: PublicTrialLimitsSummary }
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
  const [trialRightsConfirmed, setTrialRightsConfirmed] = useState(false);
  const [trialLimits, setTrialLimits] = useState<PublicTrialLimitsSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const busy =
    state.status === "validating" ||
    state.status === "checking-trial" ||
    state.status === "preparing" ||
    state.status === "downloading" ||
    state.status === "starting-trial";

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

    // 2. A signed-out visitor on a trial-enabled server goes straight to the
    //    trial offer: creating a project first would only end in a 401.
    //    Trial off, or an account already signed in: the existing chain.
    setState({ status: "checking-trial", videoId });
    const trial = await fetchPublicTrialStatus();
    if (controller.signal.aborted) return;
    if (trial.enabled && !trial.account) {
      setTrialRightsConfirmed(false);
      setState({ status: "trial-offer", videoId, limits: trial.limits });
      return;
    }

    await createProjectAndDownload(videoId, controller);
  }

  /**
   * Steps 3–5 of the chain. Shared by the account path and by the public
   * trial, which runs it again once the trial cookie has been set. `trial`
   * is passed explicitly rather than read from state: handleStartTrial calls
   * this in the same tick as setTrialLimits, before any re-render.
   */
  async function createProjectAndDownload(
    videoId: string,
    controller: AbortController,
    trial: { limits: PublicTrialLimitsSummary } | null = null
  ) {
    // 3. A downloaded video has to land somewhere the user owns.
    setState({ status: "preparing" });
    let projectId: string;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `YouTube ${videoId}` }),
      });
      if (res.status === 401) {
        // Safety net only: the trial was checked up front, but the session
        // may have expired since, or that check may have failed transiently.
        const trial = await fetchPublicTrialStatus();
        if (trial.enabled && !trial.account) {
          setTrialRightsConfirmed(false);
          setState({ status: "trial-offer", videoId, limits: trial.limits });
          return;
        }
        setState({ status: "validated", videoId });
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

    // 4. Queue the real download.
    let queued: ParsedJob;
    try {
      const res = await fetch("/api/download-youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A trial download has no account behind it: the server requires the
        // visitor's own rights confirmation on the request itself.
        body: JSON.stringify(trial ? { url, projectId, rightsConfirmed: true } : { url, projectId }),
      });
      if (res.status === 401) {
        if (trial) {
          setState({ status: "error", error: "L'essai public a expiré. Rechargez la page pour en démarrer un nouveau." });
          return;
        }
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

    // 5. Follow the job to its real conclusion.
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

  /** Public trial: only after the visitor has seen the limits and confirmed the rights. */
  async function handleStartTrial() {
    if (state.status !== "trial-offer" || !trialRightsConfirmed) return;
    const { videoId, limits } = state;
    setState({ status: "starting-trial", videoId, limits });

    try {
      const res = await fetch("/api/public-trial", { method: "POST" });
      const json = await readJson(res);
      if (!res.ok || json?.ok !== true) {
        setState({ status: "error", error: errorFrom(json, "L'essai public n'a pas pu démarrer.") });
        return;
      }
    } catch {
      setState({ status: "error", error: "Impossible de contacter le serveur." });
      return;
    }
    setTrialLimits(limits);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    await createProjectAndDownload(videoId, controller, { limits });
  }

  const buttonLabel =
    state.status === "validating" || state.status === "checking-trial"
      ? "Vérification…"
      : state.status === "preparing"
        ? "Préparation…"
        : state.status === "downloading"
          ? "Téléchargement…"
          : "Valider le lien";

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

      <div id="youtube-url-help" className="mt-2 flex flex-col gap-1 text-xs text-zinc-500">
        <p>
          Le lien est d&apos;abord vérifié. Après confirmation de vos droits sur la vidéo, elle peut être
          téléchargée et traitée sans compte via l&apos;essai public.
        </p>
        <p>
          Rien n&apos;est publié : l&apos;export de test reste filigrané, et détenir les droits sur la vidéo reste
          obligatoire.
        </p>
      </div>

      <p className="mt-3 flex items-baseline gap-2 text-sm text-zinc-400">
        <span aria-hidden="true" className="text-amber-400">
          ↳
        </span>
        <span>
          Essayez la démonstration sans créer de compte{" "}
          <a href="#studio" className="text-zinc-100 underline underline-offset-4">
            plus bas
          </a>
        </span>
      </p>

      {job && (
        <div className="mt-3">
          <JobProgress label="téléchargement YouTube" job={job} />
        </div>
      )}

      <div id="youtube-url-result" role="status" aria-live="polite" className="mt-3">
        {state.status === "validating" && (
          <p className="text-sm text-zinc-400">Vérification du lien YouTube…</p>
        )}
        {state.status === "checking-trial" && (
          <p className="text-sm text-zinc-400">
            Lien validé (id vidéo <code className="font-mono">{state.videoId}</code>). Vérification de
            l&apos;accès…
          </p>
        )}
        {state.status === "preparing" && (
          <p className="text-sm text-zinc-400">Création du projet…</p>
        )}
        {state.status === "downloading" && (
          <p className="text-sm text-zinc-400">
            Lien validé (id vidéo <code className="font-mono">{state.videoId}</code>). Téléchargement
            de la vidéo en cours…
          </p>
        )}
        {(state.status === "trial-offer" || state.status === "starting-trial") && (
          <div className="space-y-3 rounded-lg border border-sky-400/30 bg-sky-400/5 px-4 py-3 text-sm text-sky-100">
            <p>
              Lien YouTube valide (id vidéo <code className="font-mono">{state.videoId}</code>). Vous pouvez le
              traiter sans compte dans l&apos;essai public :
            </p>
            <PublicTrialNotice limits={state.limits} />
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={trialRightsConfirmed}
                onChange={(e) => setTrialRightsConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Je confirme détenir les droits sur cette vidéo, ou être autorisé à l&apos;utiliser, pour ce test.
              </span>
            </label>
            <button
              type="button"
              onClick={handleStartTrial}
              disabled={!trialRightsConfirmed || state.status === "starting-trial"}
              className="rounded-lg bg-sky-300 px-3 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.status === "starting-trial" ? "Démarrage…" : "Démarrer l'essai public"}
            </button>
            {state.status === "starting-trial" && (
              <p className="text-xs text-sky-200/80">Démarrage de l&apos;essai public…</p>
            )}
          </div>
        )}
        {state.status === "validated" && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            <p>
              Lien YouTube valide (id vidéo <code className="font-mono">{state.videoId}</code>).
            </p>
            <p className="mt-1 text-xs text-amber-100/70">
              L&apos;essai public sans compte n&apos;est pas ouvert pour le moment : vous pouvez explorer la
              démonstration en attendant.
            </p>
            <a href="#studio" className="mt-3 inline-block rounded-lg border border-amber-300/40 px-3 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/10">
              Explorer le studio ↓
            </a>
          </div>
        )}
        {state.status === "success" && (
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
            {trialLimits && (
              <p className="mb-2 text-xs text-sky-200">
                Projet d&apos;essai éphémère : supprimé automatiquement avec ses fichiers au bout de{" "}
                {formatTrialDuration(trialLimits.ttlMinutes)}.
              </p>
            )}
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
