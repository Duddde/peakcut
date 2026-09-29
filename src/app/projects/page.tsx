"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

type ProjectSummary = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  source?: { title?: string; durationSec?: number };
};

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function createProject() {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nouveau projet PeakCut" }),
    });
    const json = await response.json();
    if (!response.ok || !json.ok) {
      setError(json.error ?? "Impossible de créer le projet.");
      return;
    }
    router.push(`/projects/${json.project.id}`);
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link href="/" className="text-sm text-amber-300 hover:text-amber-200">PeakCut</Link>
            <h1 className="mt-3 text-3xl font-bold">Vos projets</h1>
            <p className="mt-2 text-sm text-zinc-400">Retrouvez vos analyses, montages et exports.</p>
          </div>
          {authenticated && (
            <button onClick={() => void createProject()} className="rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-300">
              Nouveau projet
            </button>
          )}
        </div>

        {loading && <p className="mt-12 text-sm text-zinc-500">Chargement des projets…</p>}
        {error && <p role="alert" className="mt-8 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">{error}</p>}

        {!loading && authenticated === false && (
          <section className="mt-12 rounded-2xl border border-white/10 bg-zinc-900/70 p-8 text-center">
            <h2 className="text-xl font-semibold">Connectez-vous pour retrouver vos projets</h2>
            <button onClick={() => signIn("google", { callbackUrl: "/projects" })} className="mt-6 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-300">
              Continuer avec Google
            </button>
          </section>
        )}

        {!loading && authenticated && projects.length === 0 && (
          <section className="mt-12 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-10 text-center">
            <h2 className="text-xl font-semibold">Aucun projet pour le moment</h2>
            <p className="mt-2 text-sm text-zinc-400">Créez votre premier projet pour commencer l’analyse.</p>
          </section>
        )}

        {!loading && authenticated && projects.length > 0 && (
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 transition hover:border-amber-400/50">
                <div className="flex items-start justify-between gap-4">
                  <h2 className="font-semibold text-zinc-100">{project.title}</h2>
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-zinc-400">{project.status}</span>
                </div>
                <p className="mt-3 text-xs text-zinc-500">{project.source?.title ?? "Aucun média"}</p>
                <p className="mt-1 text-xs text-zinc-600">Modifié le {new Date(project.updatedAt).toLocaleString("fr-FR")}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
