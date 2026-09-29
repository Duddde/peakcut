"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Segment, Source, Transcript, WorkflowState } from "@/lib/domain/types";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { parseAnalyzeResponse } from "@/lib/analysis/parseAnalyzeResponse";
import { parseTranscribeResponse } from "@/lib/transcript/parseTranscribeResponse";
import { parseTrackResponse } from "@/lib/tracking/parseTrackResponse";
import {
  parseProviderListResponse,
  type ParsedProviderOption,
} from "@/lib/transcript/parseProviderListResponse";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import { buildDefaultVariants } from "@/lib/domain/defaultVariants";
import { runJob } from "@/lib/jobs/jobClient";
import { ScoreExplanation } from "@/components/editor/ScoreExplanation";
import { Timeline } from "@/components/editor/Timeline";
import { TranscriptEditor } from "@/components/editor/TranscriptEditor";
import { VariantPicker } from "@/components/editor/VariantPicker";
import { AccountGate } from "@/components/AccountGate";
import { SourceIngestPanel } from "./SourceIngestPanel";
import { YoutubeSourcePanel } from "./YoutubeSourcePanel";

/** Mirrors PREVIEW_MAX_DURATION_SEC in src/lib/ffmpeg/renderPreviewSegment.ts — kept as a plain constant here since that module pulls in node:child_process and must never be imported into client code. */
const PREVIEW_MAX_DURATION_SEC = 20;


const FALLBACK_PROVIDER_OPTIONS: ParsedProviderOption[] = [
  { id: "mock-deterministic", displayName: "Démo déterministe (hors-ligne, sans clé API)", configured: true },
];

function buildSegmentFromTranscript(transcript: Transcript, sourceDurationSec: number): Segment {
  const id = `transcribed-segment-${Date.now()}`;
  const startSec = 0;
  const lastWordEnd = transcript.words[transcript.words.length - 1]?.endSec ?? 0;
  const endSec = Math.max(lastWordEnd, sourceDurationSec, 0.1);
  return {
    id,
    projectId: "transcribed-project",
    title: "Segment transcrit",
    startSec,
    endSec,
    words: transcript.words,
    score: scoreSegment({ words: transcript.words, startSec, endSec }),
    safeZones: buildDefaultSafeZones(id),
    variants: buildDefaultVariants(id),
  };
}

/**
 * The interactive studio: local media ingestion, deterministic analysis,
 * and segment editing, composed as a single client component so the
 * surrounding landing page (src/app/page.tsx) can stay a server component.
 */

type AnalyzeStatus = "idle" | "loading" | "success" | "error";

function rescoreSegment(segment: Segment): Segment {
  return {
    ...segment,
    score: scoreSegment({
      words: segment.words,
      startSec: segment.startSec,
      endSec: segment.endSec,
    }),
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch {
    return iso;
  }
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export function StudioSection({
  initialProject,
  onSave,
  projectId,
}: {
  initialProject: Project;
  /**
   * When provided, an explicit "Enregistrer" button appears. Saving is
   * always explicit and user-triggered — StudioSection never auto-saves or
   * re-fetches behind the user's back, so in-progress local edits are
   * never silently overwritten. On failure, local state is left untouched
   * so nothing is lost.
   */
  onSave?: (project: Project) => Promise<SaveResult>;
  /** Forwarded to SourceIngestPanel so an import is associated with and persisted to this project. Omitted on the public demo. */
  projectId?: string;
}) {
  const [title, setTitle] = useState(initialProject.title);
  const [source, setSource] = useState<Source>(initialProject.source);
  const [workflow, setWorkflow] = useState<WorkflowState>(initialProject.workflow);
  const [segments, setSegments] = useState<Segment[]>(initialProject.segments);
  const [selectedSegmentId, setSelectedSegmentId] = useState(initialProject.segments[0]?.id ?? "");
  const [selectedVariantBySegment, setSelectedVariantBySegment] = useState<Record<string, string>>(
    () => Object.fromEntries(initialProject.segments.map((s) => [s.id, s.variants[0]?.id ?? ""]))
  );
  const [analyzeStatus, setAnalyzeStatus] = useState<AnalyzeStatus>("idle");
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null);

  const [providerOptions, setProviderOptions] = useState<ParsedProviderOption[]>(
    FALLBACK_PROVIDER_OPTIONS
  );
  const [selectedProviderId, setSelectedProviderId] = useState("mock-deterministic");
  const [transcribeStatus, setTranscribeStatus] = useState<AnalyzeStatus>("idle");
  const [transcribeMessage, setTranscribeMessage] = useState<string | null>(null);

  const [trackProviderId, setTrackProviderId] = useState<"stable-center-fallback" | "local-subject">(
    "stable-center-fallback"
  );
  const [trackStatus, setTrackStatus] = useState<AnalyzeStatus>("idle");
  const [trackMessage, setTrackMessage] = useState<string | null>(null);
  const [trackResult, setTrackResult] = useState<{
    fallbackUsed: boolean;
    method: string;
    averageConfidencePct: number;
  } | null>(null);
  const [renderStatus, setRenderStatus] = useState<AnalyzeStatus>("idle");
  const [renderMessage, setRenderMessage] = useState<string | null>(null);

  const [previewStatus, setPreviewStatus] = useState<AnalyzeStatus>("idle");
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewIsBrowserFallback, setPreviewIsBrowserFallback] = useState(false);

  const [downloadStatus, setDownloadStatus] = useState<AnalyzeStatus>("idle");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [showAccountGate, setShowAccountGate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcript-providers")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        const options = parseProviderListResponse(json);
        if (options.length > 0) setProviderOptions(options);
      })
      .catch(() => {
        // Keep the offline mock-only fallback; the studio must stay usable even
        // if this informational request fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<AnalyzeStatus>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const skipNextDirtyCheck = useRef(true);

  useEffect(() => {
    if (skipNextDirtyCheck.current) {
      skipNextDirtyCheck.current = false;
      return;
    }
    setDirty(true);
  }, [title, source, workflow, segments]);

  async function handleSaveProject() {
    if (!onSave) return;
    setSaveStatus("loading");
    setSaveMessage("Enregistrement en cours…");
    const projectToSave: Project = {
      ...initialProject,
      title,
      source,
      workflow,
      segments,
      updatedAt: new Date().toISOString(),
    };
    const result = await onSave(projectToSave);
    if (result.ok) {
      setDirty(false);
      setSaveStatus("success");
      setSaveMessage("Projet enregistré.");
    } else {
      setSaveStatus("error");
      setSaveMessage(result.error ?? "Échec de l'enregistrement — vos modifications locales sont conservées.");
    }
  }

  const selectedSegment = useMemo(
    () => segments.find((s) => s.id === selectedSegmentId) ?? segments[0],
    [segments, selectedSegmentId]
  );

  function updateSegment(id: string, updater: (segment: Segment) => Segment) {
    setSegments((prev) => prev.map((s) => (s.id === id ? rescoreSegment(updater(s)) : s)));
  }

  function handleIngested(result: { source: Source; workflow: WorkflowState }) {
    setSource(result.source);
    setWorkflow(result.workflow);
    setAnalyzeStatus("idle");
    setAnalyzeMessage(null);
  }

  /**
   * A download job has already written the new source onto the project
   * server-side, and the job result deliberately redacts the server path,
   * so the freshly-persisted project is re-read from the server rather
   * than reconstructed here from a partial payload.
   */
  function handleDownloaded() {
    window.location.reload();
  }

  async function handleAnalyze() {
    setAnalyzeStatus("loading");
    setAnalyzeMessage("Analyse en cours…");
    try {
      if (projectId) {
        const job = await runJob(
          { projectId, kind: "analysis", payload: {}, idempotencyKey: `analysis:${projectId}:${source.id}` },
          { onUpdate: (current) => setAnalyzeMessage(`Analyse en cours… ${current.progress}%`) }
        );
        if (job.status !== "succeeded") throw new Error(job.errorMessage ?? "Le job d'analyse a échoué.");
        setAnalyzeStatus("success");
        setAnalyzeMessage("Analyse terminée et sauvegardée dans le projet.");
        window.location.reload();
        return;
      }
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setAnalyzeStatus("error");
        setAnalyzeMessage(json?.error ?? "L'analyse a échoué.");
        return;
      }

      const parsed = parseAnalyzeResponse(json);
      setSegments(parsed);
      setSelectedSegmentId(parsed[0]?.id ?? "");
      setSelectedVariantBySegment(Object.fromEntries(parsed.map((s) => [s.id, s.variants[0]?.id ?? ""])));
      setAnalyzeStatus("success");
      setAnalyzeMessage(
        `Analyse terminée : ${parsed.length} segment(s) classé(s) — les segments de démonstration ont été remplacés.`
      );
    } catch {
      setAnalyzeStatus("error");
      setAnalyzeMessage("Impossible de contacter le serveur d'analyse.");
    }
  }

  async function handleTranscribe() {
    if (!source.localFilePath) return;
    const providerLabel =
      providerOptions.find((p) => p.id === selectedProviderId)?.displayName ?? selectedProviderId;
    setTranscribeStatus("loading");
    setTranscribeMessage(`Transcription en cours avec ${providerLabel}…`);
    try {
      if (projectId) {
        const job = await runJob(
          {
            projectId,
            kind: "transcription",
            payload: { providerId: selectedProviderId },
            idempotencyKey: `transcription:${projectId}:${source.id}:${selectedProviderId}`,
          },
          { onUpdate: (current) => setTranscribeMessage(`Transcription en cours… ${current.progress}%`) }
        );
        if (job.status !== "succeeded") throw new Error(job.errorMessage ?? "Le job de transcription a échoué.");
        setTranscribeStatus("success");
        setTranscribeMessage("Transcription terminée et sauvegardée dans le projet.");
        window.location.reload();
        return;
      }
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: selectedProviderId, sourcePath: source.localFilePath }),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setTranscribeStatus("error");
        setTranscribeMessage(json?.error ?? "La transcription a échoué.");
        return;
      }

      const parsed = parseTranscribeResponse(json);
      const newSegment = buildSegmentFromTranscript(parsed.transcript, source.durationSec);
      setSegments([newSegment]);
      setSelectedSegmentId(newSegment.id);
      setSelectedVariantBySegment({ [newSegment.id]: newSegment.variants[0]?.id ?? "" });
      setTranscribeStatus("success");
      setTranscribeMessage(
        `Transcription réussie via ${parsed.providerId} (${parsed.transcript.words.length} mots).`
      );
    } catch {
      setTranscribeStatus("error");
      setTranscribeMessage("Impossible de contacter le serveur de transcription.");
    }
  }

  async function handleTrack() {
    if (!source.localFilePath) return;
    setTrackStatus("loading");
    setTrackResult(null);
    setTrackMessage("Détection du cadrage en cours…");
    try {
      if (projectId) {
        const job = await runJob(
          {
            projectId,
            kind: "tracking",
            payload: { provider: trackProviderId },
            idempotencyKey: `tracking:${projectId}:${source.id}:${trackProviderId}`,
          },
          { onUpdate: (current) => setTrackMessage(`Détection du cadrage en cours… ${current.progress}%`) }
        );
        if (job.status !== "succeeded") throw new Error(job.errorMessage ?? "Le job de tracking a échoué.");
        setTrackStatus("success");
        setTrackMessage("Tracking terminé et sauvegardé dans le projet.");
        window.location.reload();
        return;
      }
      const res = await fetch("/api/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePath: source.localFilePath, provider: trackProviderId }),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setTrackStatus("error");
        setTrackMessage(json?.error ?? "La détection de cadrage a échoué.");
        return;
      }

      const parsed = parseTrackResponse(json);
      const keyframes = parsed.track.keyframes;
      const averageConfidencePct = Math.round(
        (keyframes.reduce((sum, k) => sum + k.confidence, 0) / Math.max(1, keyframes.length)) * 100
      );
      setTrackResult({ fallbackUsed: parsed.track.fallbackUsed, method: parsed.track.method, averageConfidencePct });
      setTrackStatus("success");
      setTrackMessage(
        parsed.track.fallbackUsed
          ? "Cadrage centré de repli appliqué : aucune détection réelle de sujet n'a été utilisée."
          : `Cadrage suivi avec une confiance moyenne de ${averageConfidencePct}%.`
      );
    } catch {
      setTrackStatus("error");
      setTrackMessage("Impossible de contacter le serveur de suivi de cadrage.");
    }
  }

  async function handleRender() {
    if (!projectId || !selectedSegment) return;
    if (!workflow.rights.confirmed || workflow.phase !== "export_authorized") {
      setRenderStatus("error");
      setRenderMessage("Export bloqué : confirmez les droits et autorisez l'export humainement.");
      return;
    }
    const variantId = selectedVariantBySegment[selectedSegment.id] ?? selectedSegment.variants[0]?.id;
    if (!variantId) {
      setRenderStatus("error");
      setRenderMessage("Export impossible : aucune variante sélectionnée.");
      return;
    }
    setRenderStatus("loading");
    setRenderMessage("Rendu en file d'attente…");
    try {
      const job = await runJob(
        {
          projectId,
          kind: "render",
          payload: { segmentId: selectedSegment.id, variantId },
          idempotencyKey: `render:${projectId}:${selectedSegment.id}:${variantId}`,
        },
        { onUpdate: (current) => setRenderMessage(`Rendu en cours… ${current.progress}%`) }
      );
      if (job.status !== "succeeded") throw new Error(job.errorMessage ?? "Le rendu a échoué.");
      setRenderStatus("success");
      setRenderMessage("Rendu terminé et vérifié. Le fichier est disponible dans les exports du projet.");
    } catch (error) {
      setRenderStatus("error");
      setRenderMessage(error instanceof Error ? error.message : "Le rendu a échoué.");
    }
  }

  /**
   * Free, anonymous preview: low-resolution, watermarked, capped at
   * PREVIEW_MAX_DURATION_SEC, never gated by an account. If the server
   * can't produce one (disabled, rate-limited, ffmpeg failure), this is
   * reported honestly and the user is pointed back at the real local
   * blob preview already shown above (in SourceIngestPanel) — never a
   * fabricated file or a silently-substituted fake success.
   */
  async function handlePreview() {
    if (!selectedSegment || !source.localFilePath) return;
    setPreviewStatus("loading");
    setPreviewMessage("Génération de l'aperçu gratuit (filigrane, résolution réduite)…");
    setPreviewUrl(null);
    setPreviewIsBrowserFallback(false);
    const endSec = Math.min(selectedSegment.endSec, selectedSegment.startSec + PREVIEW_MAX_DURATION_SEC);
    try {
      const res = await fetch("/api/preview-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePath: source.localFilePath, startSec: selectedSegment.startSec, endSec }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setPreviewStatus("success");
        setPreviewIsBrowserFallback(true);
        setPreviewMessage(
          `Aperçu serveur indisponible (${json?.error ?? "erreur inconnue"}) — utilisez la prévisualisation locale ci-dessus en attendant.`
        );
        return;
      }
      setPreviewUrl(json.url);
      setPreviewStatus("success");
      setPreviewMessage(
        `Aperçu avec filigrane prêt (expire à ${new Date(json.expiresAt).toLocaleTimeString("fr-FR")}).`
      );
    } catch {
      setPreviewStatus("success");
      setPreviewIsBrowserFallback(true);
      setPreviewMessage(
        "Impossible de contacter le serveur d'aperçu — utilisez la prévisualisation locale ci-dessus en attendant."
      );
    }
  }

  /**
   * The final, full-quality, unwatermarked download — unlike handlePreview,
   * this always requires an authenticated account. The check here is only
   * a UX nicety (avoids a pointless round trip); /api/export-segment
   * enforces the same requirement server-side regardless.
   */
  async function handleDownloadClick() {
    if (!selectedSegment || !source.localFilePath) return;
    setDownloadStatus("loading");
    setDownloadMessage("Vérification du compte…");
    try {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      const meJson = await meRes.json();
      if (!meJson?.authenticated) {
        setDownloadStatus("idle");
        setDownloadMessage(null);
        setShowAccountGate(true);
        return;
      }

      setDownloadMessage("Export final en cours…");
      const variantId = selectedVariantBySegment[selectedSegment.id] ?? selectedSegment.variants[0]?.id;
      const variant = selectedSegment.variants.find((v) => v.id === variantId);
      const res = await fetch("/api/export-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourcePath: source.localFilePath,
          startSec: selectedSegment.startSec,
          endSec: selectedSegment.endSec,
          words: selectedSegment.words.map((w) => ({
            text: w.text,
            start_sec: w.startSec,
            end_sec: w.endSec,
            speaker: w.speaker ?? null,
            confidence: w.confidence,
          })),
          crop: variant?.crop,
          workflow,
        }),
      });
      if (res.status === 401) {
        setDownloadStatus("idle");
        setDownloadMessage(null);
        setShowAccountGate(true);
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setDownloadStatus("error");
        setDownloadMessage(
          Array.isArray(json?.reasons) && json.reasons.length > 0
            ? json.reasons.join(" ")
            : (json?.error ?? "Échec de l'export.")
        );
        return;
      }
      setDownloadStatus("success");
      setDownloadMessage(
        `Export terminé et vérifié (${json.output.duration_sec.toFixed(1)}s, ${json.output.width}×${json.output.height}).`
      );
    } catch {
      setDownloadStatus("error");
      setDownloadMessage("Impossible de contacter le serveur d'export.");
    }
  }

  if (!selectedSegment) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <input
            aria-label="Titre du projet"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full max-w-xl rounded-lg border border-white/10 bg-transparent px-3 py-2 text-lg font-semibold text-zinc-100 outline-none focus:border-amber-400/60"
          />
          {onSave && (
            <div className="flex flex-col items-end gap-1">
              <button type="button" onClick={handleSaveProject} disabled={!dirty || saveStatus === "loading"} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50">
                {saveStatus === "loading" ? "Enregistrement…" : dirty ? "Enregistrer" : "Enregistré"}
              </button>
              <p role="status" aria-live="polite" className={saveStatus === "error" ? "text-xs text-rose-300" : "text-xs text-zinc-500"}>
                {saveMessage ?? (dirty ? "Modifications non enregistrées." : "")}
              </p>
            </div>
          )}
        </div>
        <SourceIngestPanel onIngested={handleIngested} projectId={projectId} />
        <YoutubeSourcePanel projectId={projectId} onDownloaded={handleDownloaded} />
        <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
          Importez un média ou téléchargez une vidéo YouTube pour générer les premiers segments
          éditables.
        </div>
      </div>
    );
  }
  const selectedVariantId =
    selectedVariantBySegment[selectedSegment.id] ?? selectedSegment.variants[0]?.id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="studio-project-title">
            Titre du projet
          </label>
          <input
            id="studio-project-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-lg font-semibold text-zinc-100 outline-none focus:border-amber-400/60"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Workflow : {workflow.phase} · droits confirmés : {workflow.rights.confirmed ? "oui" : "non"}
          </p>
        </div>
        {onSave && (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleSaveProject}
              disabled={!dirty || saveStatus === "loading"}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveStatus === "loading" ? "Enregistrement…" : dirty ? "Enregistrer" : "Enregistré"}
            </button>
            <p
              role="status"
              aria-live="polite"
              aria-label="Statut de l'enregistrement"
              className={`text-xs ${
                saveStatus === "error" ? "text-rose-300" : saveStatus === "success" ? "text-emerald-300" : "text-zinc-500"
              }`}
            >
              {saveMessage ?? (dirty ? "Modifications non enregistrées." : "")}
            </p>
          </div>
        )}
      </div>

      <SourceIngestPanel onIngested={handleIngested} projectId={projectId} />

      <YoutubeSourcePanel projectId={projectId} onDownloaded={handleDownloaded} />

      <div
        data-testid="current-source-card"
        className="space-y-2 rounded-2xl border border-white/10 bg-zinc-900/60 p-5"
      >
        <h3 className="text-sm font-semibold text-zinc-100">Source actuelle</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
          <dt className="text-zinc-600">Titre</dt>
          <dd className="text-zinc-200">{source.title}</dd>
          <dt className="text-zinc-600">Type</dt>
          <dd className="text-zinc-200">
            {source.type === "local-upload"
              ? "Fichier local"
              : source.localFilePath
                ? "Vidéo YouTube téléchargée"
                : "URL YouTube (pas encore téléchargée)"}
          </dd>
          <dt className="text-zinc-600">Durée détectée</dt>
          <dd className="text-zinc-200">{source.durationSec.toFixed(1)}s</dd>
          <dt className="text-zinc-600">Confiance des métadonnées</dt>
          <dd className="text-zinc-200">{Math.round(source.confidence * 100)}%</dd>
          <dt className="text-zinc-600">Origine (horodatage)</dt>
          <dd className="text-zinc-200">{formatDate(source.originTimestamp)}</dd>
        </dl>
        <p className="text-[11px] text-zinc-500">
          {source.localFilePath
            ? "Fichier média prêt côté serveur pour un export réel."
            : "Aperçu uniquement pour le moment : aucun fichier média n'est encore associé à cette source."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={analyzeStatus === "loading"}
          className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {analyzeStatus === "loading" ? "Analyse…" : "Lancer l'analyse (démo déterministe)"}
        </button>
        <p
          role="status"
          aria-live="polite"
          aria-label="Statut de l'analyse"
          className={`text-xs ${
            analyzeStatus === "error"
              ? "text-rose-300"
              : analyzeStatus === "success"
                ? "text-emerald-300"
                : "text-zinc-500"
          }`}
        >
          {analyzeMessage}
        </p>
      </div>

      <div className="space-y-2 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <h3 className="text-sm font-semibold text-zinc-100">Transcription réelle</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Fournisseur
            <select
              value={selectedProviderId}
              onChange={(e) => setSelectedProviderId(e.target.value)}
              className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
            >
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.configured}>
                  {p.displayName}
                  {p.configured ? "" : " (non configuré)"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={handleTranscribe}
            disabled={!source.localFilePath || transcribeStatus === "loading"}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {transcribeStatus === "loading" ? "Transcription…" : "Transcrire ce média"}
          </button>
        </div>
        {!source.localFilePath && (
          <p className="text-[11px] text-zinc-500">
            Importez un média local ci-dessus pour activer la transcription réelle. Les segments de
            démonstration restent inchangés tant qu&apos;aucun média n&apos;a été importé.
          </p>
        )}
        <p
          role="status"
          aria-live="polite"
          aria-label="Statut de la transcription"
          className={`text-xs ${
            transcribeStatus === "error"
              ? "text-rose-300"
              : transcribeStatus === "success"
                ? "text-emerald-300"
                : "text-zinc-500"
          }`}
        >
          {transcribeMessage}
        </p>
      </div>

      <div className="space-y-2 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <h3 className="text-sm font-semibold text-zinc-100">Cadrage automatique</h3>
        <p className="text-[11px] text-zinc-500">
          Le repli centré ne détecte aucun visage réel — il garde simplement le cadre centré. Le
          suivi de sujet local nécessite un moteur de détection externe configuré séparément
          (PEAKCUT_TRACKER_COMMAND) et n&apos;est pas fourni par PeakCut.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Méthode
            <select
              value={trackProviderId}
              onChange={(e) => setTrackProviderId(e.target.value as typeof trackProviderId)}
              className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
            >
              <option value="stable-center-fallback">Centré stable (repli, sans détection)</option>
              <option value="local-subject">Suivi de sujet local (moteur externe requis)</option>
            </select>
          </label>
          <button
            type="button"
            onClick={handleTrack}
            disabled={!source.localFilePath || trackStatus === "loading"}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {trackStatus === "loading" ? "Détection…" : "Détecter le cadrage"}
          </button>
        </div>
        {!source.localFilePath && (
          <p className="text-[11px] text-zinc-500">
            Importez un fichier local ci-dessus pour activer la détection de cadrage.
          </p>
        )}
        {trackResult && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
            <dt className="text-zinc-600">Repli utilisé</dt>
            <dd className="text-zinc-200">{trackResult.fallbackUsed ? "Oui" : "Non"}</dd>
            <dt className="text-zinc-600">Méthode</dt>
            <dd className="text-zinc-200">{trackResult.method}</dd>
            <dt className="text-zinc-600">Confiance moyenne</dt>
            <dd className="text-zinc-200">{trackResult.averageConfidencePct}%</dd>
          </dl>
        )}
        <p
          role="status"
          aria-live="polite"
          aria-label="Statut du cadrage automatique"
          className={`text-xs ${
            trackStatus === "error" ? "text-rose-300" : trackStatus === "success" ? "text-emerald-300" : "text-zinc-500"
          }`}
        >
          {trackMessage}
        </p>
      </div>

      <Timeline
        segments={segments}
        totalDurationSec={Math.max(0, ...segments.map((s) => s.endSec))}
        selectedSegmentId={selectedSegmentId}
        onSelect={setSelectedSegmentId}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="studio-segment-title">
              Titre du segment
            </label>
            <input
              id="studio-segment-title"
              type="text"
              value={selectedSegment.title}
              onChange={(e) =>
                updateSegment(selectedSegment.id, (s) => ({ ...s, title: e.target.value }))
              }
              className="w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-base font-semibold text-zinc-100 outline-none focus:border-amber-400/60"
            />
            <div className="mt-2 flex gap-3 text-xs text-zinc-500">
              <label className="flex items-center gap-1">
                Début (s)
                <input
                  type="number"
                  step={0.1}
                  value={selectedSegment.startSec}
                  onChange={(e) =>
                    updateSegment(selectedSegment.id, (s) => ({
                      ...s,
                      startSec: Number(e.target.value),
                    }))
                  }
                  className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                />
              </label>
              <label className="flex items-center gap-1">
                Fin (s)
                <input
                  type="number"
                  step={0.1}
                  value={selectedSegment.endSec}
                  onChange={(e) =>
                    updateSegment(selectedSegment.id, (s) => ({
                      ...s,
                      endSec: Number(e.target.value),
                    }))
                  }
                  className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                />
              </label>
            </div>
          </div>

          {selectedSegment.score && <ScoreExplanation score={selectedSegment.score} />}
        </div>

        <div className="space-y-6 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <TranscriptEditor
            words={selectedSegment.words}
            onChangeWord={(index, patch) =>
              updateSegment(selectedSegment.id, (s) => ({
                ...s,
                words: s.words.map((w, i) => (i === index ? { ...w, ...patch } : w)),
              }))
            }
          />
          <VariantPicker
            variants={selectedSegment.variants}
            selectedVariantId={selectedVariantId}
            onSelect={(id) =>
              setSelectedVariantBySegment((prev) => ({ ...prev, [selectedSegment.id]: id }))
            }
            onChangeCrop={(variantId, patch) =>
              updateSegment(selectedSegment.id, (s) => ({
                ...s,
                variants: s.variants.map((v) =>
                  v.id === variantId ? { ...v, crop: { ...v.crop, ...patch } } : v
                ),
              }))
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
        Mode validation humaine actif : aucun export ni aucune publication n&apos;est déclenché
        automatiquement. Les droits sur la source doivent être confirmés par un humain avant tout
        export.
      </div>
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Export MP4</h3>
            <p className="mt-1 text-xs text-zinc-500">Le rendu est exécuté par le worker et vérifié par FFprobe.</p>
          </div>
          <button type="button" onClick={handleRender} disabled={!projectId || renderStatus === "loading"} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50">
            {renderStatus === "loading" ? "Rendu…" : "Lancer le rendu"}
          </button>
        </div>
        <p role="status" aria-live="polite" className={`mt-3 text-xs ${renderStatus === "error" ? "text-rose-300" : renderStatus === "success" ? "text-emerald-300" : "text-zinc-500"}`}>
          {renderMessage ?? "Validation humaine obligatoire avant export."}
        </p>
      </div>

      {!projectId && source.localFilePath && (
        <div data-testid="preview-panel" className="space-y-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Aperçu gratuit</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Aperçu basse résolution avec filigrane PeakCut, limité à {PREVIEW_MAX_DURATION_SEC}s, sans
              compte. Le téléchargement final en pleine qualité (sans filigrane) nécessite un compte.
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
            <dt className="text-zinc-600">Segment</dt>
            <dd className="text-zinc-200">{selectedSegment.title}</dd>
            <dt className="text-zinc-600">Fenêtre</dt>
            <dd className="text-zinc-200">
              {selectedSegment.startSec.toFixed(1)}s –{" "}
              {Math.min(selectedSegment.endSec, selectedSegment.startSec + PREVIEW_MAX_DURATION_SEC).toFixed(1)}s
            </dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewStatus === "loading"}
              className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewStatus === "loading" ? "Génération…" : "Générer l'aperçu"}
            </button>
            <button
              type="button"
              onClick={handleDownloadClick}
              disabled={downloadStatus === "loading"}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadStatus === "loading" ? "Vérification…" : "Télécharger (compte requis)"}
            </button>
          </div>
          {previewUrl && !previewIsBrowserFallback && (
            <video
              data-testid="server-preview-video"
              src={previewUrl}
              controls
              className="max-h-64 w-full rounded-lg bg-black"
            />
          )}
          <p
            role="status"
            aria-live="polite"
            aria-label="Statut de l'aperçu"
            className={`text-xs ${previewStatus === "error" ? "text-rose-300" : "text-zinc-500"}`}
          >
            {previewMessage}
          </p>
          <p
            role="status"
            aria-live="polite"
            aria-label="Statut du téléchargement"
            className={`text-xs ${downloadStatus === "error" ? "text-rose-300" : downloadStatus === "success" ? "text-emerald-300" : "text-zinc-500"}`}
          >
            {downloadMessage}
          </p>
        </div>
      )}

      {showAccountGate && (
        <AccountGate
          callbackUrl={typeof window !== "undefined" ? window.location.href : "/"}
          onClose={() => setShowAccountGate(false)}
        />
      )}
    </div>
  );
}
