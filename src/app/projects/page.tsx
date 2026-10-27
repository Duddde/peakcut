"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AccountGate } from "@/components/AccountGate";
import { listDemoProjectSummaries, type DemoProjectSummary } from "@/lib/demo/demoProjects";
import { validateYoutubeUrl } from "@/lib/youtube/validateYoutubeUrl";

type ProjectSummary = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  source?: { title?: string; durationSec?: number };
};

const PROJECTS_CALLBACK_URL = "/projects";
const LOGIN_HREF = `/login?callbackUrl=${encodeURIComponent(PROJECTS_CALLBACK_URL)}`;

function formatDuration(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

/**
 * /projects is browsable without a session: the public demonstration cards
 * are built locally (see demoProjects.ts) and always shown. A signed-in
 * visitor additionally sees their own projects, loaded from the
 * authenticated /api/projects route. Creating a project without a session
 * opens the account gate instead of calling the API.
 */
export default function ProjectsPage() {
  const router = useRouter();
  const [demoProjects, setDemoProjects] = useState<DemoProjectSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAccountGate, setShowAccountGate] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [startingFromUrl, setStartingFromUrl] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (response.status === 401) {
        setAuthenticated(false);
        setProjects([]);
        return;
      }
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error ?? "Impossible de charger les projets.");
      setAuthenticated(true);
      setProjects(json.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de charger les projets.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void listDemoProjectSummaries().then((summaries) => {
      if (!cancelled) setDemoProjects(summaries);
    });
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  /** The new project's id, or null when it could not be created (the reason is already shown). */
  async function postProject(title: string): Promise<string | null> {
    if (!authenticated) {
      setShowAccountGate(true);
      return null;
    }
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (response.status === 401) {
      setAuthenticated(false);
      setShowAccountGate(true);
      return null;
    }
    const json = await response.json();
    if (!response.ok || !json.ok) {
      setError(json.error ?? "Impossible de créer le projet.");
      return null;
    }
    return json.project.id as string;
  }

  async function createProject() {
    const id = await postProject("Nouveau projet PeakCut");
    if (id) router.push(`/projects/${id}`);
  }

  /**
   * Paste a link, get clips: the project is created here and the studio
   * starts the whole pipeline on the link it receives (`?url=`), so there
   * is nothing left to click on the way.
   */
  async function startFromYoutubeUrl(rawUrl: string) {
    const validation = validateYoutubeUrl(rawUrl.trim());
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    if (startingFromUrl) return;
    setStartingFromUrl(true);
    setError(null);
    const id = await postProject(`YouTube ${validation.videoId}`);
    if (!id) {
      setStartingFromUrl(false);
      return;
    }
    router.push(`/projects/${id}?url=${encodeURIComponent(validation.normalizedUrl)}`);
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link href="/" className="text-sm text-amber-300 hover:text-amber-200">PeakCut</Link>
            <h1 className="mt-3 text-3xl font-bold">{authenticated ? "Vos projets" : "Explorer les projets"}</h1>
            <p className="mt-2 text-sm text-zinc-400">
              {authenticated
                ? "Retrouvez vos analyses, montages et exports."
                : "Parcourez des projets de démonstration complets, sans compte."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void createProject()}
            disabled={loading}
            className="rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
          >
            Nouveau projet
          </button>
        </div>

        {authenticated === false && (
          <section
            aria-label="Mode exploration"
            className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5"
          >
            <p className="text-sm text-amber-100">
              Mode exploration : les démonstrations sont consultables librement. La personnalisation, l’import, l’export et la
              sauvegarde de vos projets demandent une connexion.
            </p>
            <a
              href={LOGIN_HREF}
              className="rounded-xl border border-amber-300/60 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-300/10"
            >
              Se connecter
            </a>
          </section>
        )}

        {authenticated && (
          <form
            aria-label="Nouveau projet depuis un lien YouTube"
            onSubmit={(event) => {
              event.preventDefault();
              void startFromYoutubeUrl(youtubeUrl);
            }}
            className="mt-8 space-y-3 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5"
          >
            <label htmlFor="projects-youtube-url" className="block text-sm font-semibold text-amber-100">
              Collez un lien YouTube : les clips se préparent tout seuls
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="projects-youtube-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://www.youtube.com/watch?v=..."
                value={youtubeUrl}
                disabled={startingFromUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text").trim();
                  if (!validateYoutubeUrl(pasted).ok) return;
                  event.preventDefault();
                  setYoutubeUrl(pasted);
                  void startFromYoutubeUrl(pasted);
                }}
                className="w-full flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none ring-amber-400/50 transition focus:border-amber-400/60 focus:ring-2"
              />
              <button
                type="submit"
                disabled={startingFromUrl || youtubeUrl.trim().length === 0}
                className="shrink-0 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {startingFromUrl ? "Création…" : "Lancer"}
              </button>
            </div>
            <p className="text-xs text-zinc-400">
              Téléchargement, transcription, découpage en clips, cadrage sur celui qui parle, puis aperçu du
              meilleur clip — sans autre clic.
            </p>
          </form>
        )}

        {error && <p role="alert" className="mt-8 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">{error}</p>}

        {(loading || authenticated) && (
          <section aria-labelledby="my-projects-heading" className="mt-10">
            <h2 id="my-projects-heading" className="text-lg font-semibold">Mes projets</h2>
            {loading && <p className="mt-4 text-sm text-zinc-500">Chargement des projets…</p>}

            {!loading && authenticated && projects.length === 0 && (
              <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-10 text-center">
                <h3 className="text-xl font-semibold">Aucun projet pour le moment</h3>
                <p className="mt-2 text-sm text-zinc-400">Créez votre premier projet pour commencer l’analyse.</p>
              </div>
            )}

            {!loading && authenticated && projects.length > 0 && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {projects.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`} className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 transition hover:border-amber-400/50">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-semibold text-zinc-100">{project.title}</h3>
                      <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-zinc-400">{project.status}</span>
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">{project.source?.title ?? "Aucun média"}</p>
                    <p className="mt-1 text-xs text-zinc-600">Modifié le {new Date(project.updatedAt).toLocaleString("fr-FR")}</p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="demo-projects-heading" className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="demo-projects-heading" className="text-lg font-semibold">Projets de démonstration</h2>
            <p className="text-xs text-zinc-500">Lecture seule · accessibles sans compte</p>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {demoProjects.map((demo) => (
              <Link
                key={demo.id}
                href={`/projects/${demo.id}`}
                className="group flex flex-col rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 p-5 transition hover:-translate-y-0.5 hover:border-amber-400/50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="rounded-full bg-amber-400/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                    {demo.format}
                  </span>
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-zinc-400">Démo</span>
                </div>
                <h3 className="mt-4 font-semibold text-zinc-100 group-hover:text-amber-100">{demo.title}</h3>
                <p className="mt-2 text-xs text-zinc-500">{demo.sourceTitle}</p>
                <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white/[0.04] p-2">
                    <dt className="text-[10px] text-zinc-500">Durée</dt>
                    <dd className="mt-1 text-xs font-semibold text-zinc-200">{formatDuration(demo.durationSec)}</dd>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-2">
                    <dt className="text-[10px] text-zinc-500">Moments</dt>
                    <dd className="mt-1 text-xs font-semibold text-zinc-200">{demo.segmentCount}</dd>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-2">
                    <dt className="text-[10px] text-zinc-500">Score max</dt>
                    <dd className="mt-1 text-xs font-semibold text-amber-200">{demo.topScore}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        </section>
      </div>

      {showAccountGate && (
        <AccountGate
          callbackUrl={PROJECTS_CALLBACK_URL}
          title="Un compte est nécessaire pour créer un projet"
          body="Les démonstrations restent consultables sans compte. Connectez-vous pour créer, personnaliser, importer, exporter et sauvegarder vos projets."
          onClose={() => setShowAccountGate(false)}
        />
      )}
    </main>
  );
}
