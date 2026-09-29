"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Project } from "@/lib/domain/types";
import { parseProjectResponse, ProjectInputParseError } from "@/lib/db/parseProjectInput";
import { StudioSection, type SaveResult } from "@/components/studio/StudioSection";

type PageState = "loading" | "ready" | "not-found" | "error";

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<PageState>("loading");

  useEffect(() => {
    let cancelled = false;
    void params.then(async ({ id: projectId }) => {
      if (cancelled) return;
      setId(projectId);
      try {
        const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        if (response.status === 401 || response.status === 404) {
          if (!cancelled) setState("not-found");
          return;
        }
        const json = await response.json();
        if (!response.ok || !json.ok) throw new Error(json.error ?? "Projet introuvable.");
        const parsed = parseProjectResponse(json.project);
        if (cancelled) return;
        setProject(parsed);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  async function handleSave(updated: Project): Promise<SaveResult> {
    if (!id) return { ok: false, error: "Projet non identifié." };
    try {
      const response = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: updated.title,
          source: updated.source,
          transcript: updated.transcript,
          segments: updated.segments,
          timeline: updated.timeline,
          workflow: updated.workflow,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        return { ok: false, error: json.error ?? "Échec de l'enregistrement." };
      }
      try {
        const parsed = parseProjectResponse(json.project);
        setProject(parsed);
      } catch (err) {
        if (err instanceof ProjectInputParseError) {
          return { ok: false, error: "Réponse serveur invalide après enregistrement." };
        }
        throw err;
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Impossible de contacter le serveur. Vos modifications locales sont conservées." };
    }
  }

  if (state === "loading") {
    return <main className="min-h-screen bg-zinc-950 p-8 text-zinc-400">Chargement du projet…</main>;
  }
  if (state === "not-found") {
    return (
      <main className="min-h-screen bg-zinc-950 p-8 text-rose-300">
        <p>Projet introuvable ou accès refusé.</p>
        <Link href="/projects" className="mt-4 inline-block text-sm text-amber-300 hover:text-amber-200">
          ← Tous les projets
        </Link>
      </main>
    );
  }
  if (state === "error" || !project) {
    return (
      <main className="min-h-screen bg-zinc-950 p-8 text-rose-300">
        <p>Une erreur est survenue lors du chargement du projet.</p>
        <Link href="/projects" className="mt-4 inline-block text-sm text-amber-300 hover:text-amber-200">
          ← Tous les projets
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-6xl">
        <Link href="/projects" className="text-sm text-amber-300 hover:text-amber-200">
          ← Tous les projets
        </Link>
        <div className="mt-8">
          <StudioSection initialProject={project} projectId={project.id} onSave={handleSave} />
        </div>
      </div>
    </main>
  );
}
