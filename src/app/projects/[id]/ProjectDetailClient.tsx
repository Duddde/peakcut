"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Project } from "@/lib/domain/types";
import { parseProjectResponse, ProjectInputParseError } from "@/lib/db/parseProjectInput";
import { StudioSection, type SaveResult } from "@/components/studio/StudioSection";
import { parsePublicTrialInfo, type PublicTrialInfo } from "@/lib/publicTrial/client";

type PageState = "loading" | "ready" | "not-found" | "error";

interface ProjectDetailClientProps {
  projectId: string;
  /** Project already resolved on the server (public demo ids only). */
  initialProject?: Project;
  /** Read-only public demo: never loaded nor saved through the API. */
  isDemo?: boolean;
  /** A link pasted on the projects list (`?url=`): the studio starts the automatic pipeline on it. */
  autoStartUrl?: string;
}

export default function ProjectDetailClient({
  projectId,
  initialProject,
  isDemo = false,
  autoStartUrl,
}: ProjectDetailClientProps) {
  const [project, setProject] = useState<Project | null>(initialProject ?? null);
  const [state, setState] = useState<PageState>(initialProject ? "ready" : "loading");
  // Set only when the server says this project belongs to a public-trial actor.
  const [publicTrial, setPublicTrial] = useState<PublicTrialInfo | null>(null);
  // Whatever the server says; until it has, the human gate stays up.
  const [rightsConfirmationRequired, setRightsConfirmationRequired] = useState(true);
  const [claudeMotionConfigured, setClaudeMotionConfigured] = useState(false);

  // The link is dropped from the address bar once read, so that a reload
  // (the studio reloads when the pipeline is done) never starts it again.
  useEffect(() => {
    if (!autoStartUrl) return;
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("url");
    window.history.replaceState(window.history.state, "", cleaned.pathname + cleaned.search + cleaned.hash);
  }, [autoStartUrl]);

  useEffect(() => {
    // Demo projects arrive pre-resolved from the server. Every other id goes
    // through the authenticated, ownership-checked route.
    if (isDemo || initialProject) return;
    let cancelled = false;
    void (async () => {
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
        setPublicTrial(json.access === "trial" ? parsePublicTrialInfo(json.trial) : null);
        setRightsConfirmationRequired(json.rightsConfirmationRequired !== false);
        setClaudeMotionConfigured(json.claudeMotionConfigured === true);
        setProject(parsed);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, isDemo, initialProject]);

  async function handleSave(updated: Project): Promise<SaveResult> {
    if (isDemo) return { ok: false, error: "Projet de démonstration en lecture seule." };
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
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
        {publicTrial ? (
          <Link href="/" className="text-sm text-amber-300 hover:text-amber-200">
            ← Accueil
          </Link>
        ) : (
          <Link href="/projects" className="text-sm text-amber-300 hover:text-amber-200">
            ← Tous les projets
          </Link>
        )}
        {isDemo && (
          <p
            role="note"
            className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100"
          >
            Projet de démonstration en lecture seule.{" "}
            <Link
              href={`/login?callbackUrl=${encodeURIComponent(`/projects/${project.id}`)}`}
              className="font-semibold underline underline-offset-2 hover:text-amber-200"
            >
              Connectez-vous
            </Link>{" "}
            pour personnaliser, importer, exporter et sauvegarder vos propres projets.
          </p>
        )}
        <div className="mt-8">
          {isDemo ? (
            <StudioSection initialProject={project} publicDemo />
          ) : (
            <StudioSection
              initialProject={project}
              projectId={project.id}
              onSave={handleSave}
              publicTrial={publicTrial ?? undefined}
              rightsConfirmationRequired={rightsConfirmationRequired}
              autoStartUrl={autoStartUrl}
              claudeMotionConfigured={claudeMotionConfigured}
            />
          )}
        </div>
      </div>
    </main>
  );
}
