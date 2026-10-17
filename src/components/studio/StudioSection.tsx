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
import { runJob, runPipeline } from "@/lib/jobs/jobClient";
import { AUTO_PIPELINE_ORDER } from "@/lib/jobs/chain";
import type { JobKind } from "@/lib/jobs/types";
import { ScoreExplanation } from "@/components/editor/ScoreExplanation";
import { Timeline } from "@/components/editor/Timeline";
import { TranscriptEditor } from "@/components/editor/TranscriptEditor";
import { VariantPicker } from "@/components/editor/VariantPicker";
import { EffectsPanel } from "@/components/editor/EffectsPanel";
import { IllustrationsPanel } from "@/components/editor/IllustrationsPanel";
import { retimeSegment, splitSegment } from "@/lib/analysis/retimeSegment";
import { AccountGate } from "@/components/AccountGate";
import { PublicTrialNotice } from "@/components/PublicTrialNotice";
import type { PublicTrialInfo } from "@/lib/publicTrial/client";
import { authorizeExport, confirmRights } from "@/lib/workflow/workflow";
import { PUBLIC_DEMO_CALLBACK_URL, relativeUrlOf } from "@/lib/auth/safeCallbackUrl";
import { SourceIngestPanel } from "./SourceIngestPanel";
import { YoutubeSourcePanel } from "./YoutubeSourcePanel";

/** Server-side cap of a project preview window (see MAX_DURATION_SEC in /api/preview-segment). */
const PROJECT_PREVIEW_MAX_DURATION_SEC = 15;

/** Mirrors PREVIEW_MAX_DURATION_SEC in src/lib/ffmpeg/renderPreviewSegment.ts — kept as a plain constant here since that module pulls in node:child_process and must never be imported into client code. */
const PREVIEW_MAX_DURATION_SEC = 20;


/**
 * Used only until /api/transcript-providers answers (and if it never
 * does). Empty on purpose: there is no offline provider to fall back to —
 * transcription needs a configured one, and offering an option that
 * cannot work would be worse than offering none.
 */
const FALLBACK_PROVIDER_OPTIONS: ParsedProviderOption[] = [];

/**
 * The reason a studio action failed, as the user should read it.
 *
 * A job that fails for a real reason — an API refusing the request, a
 * missing binary, a media too large — reaches the caller as a thrown
 * Error carrying the server's own message. Reporting all of those as
 * "impossible de contacter le serveur" hid the actual cause behind a
 * network error that had not happened, and left no way to act on it.
 */
function failureMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim().length > 0 ? err.message : fallback;
}

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
    renderPlan: null,
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

/** What each automatic-pipeline step is called, in the user's words rather than the queue's. */
const PIPELINE_STEP_LABELS: Record<JobKind, string> = {
  download: "Téléchargement de la vidéo",
  transcription: "Transcription mot à mot",
  analysis: "Découpage et classement des clips",
  tracking: "Cadrage sur le visage",
  render: "Export",
};

interface PipelineStepView {
  kind: JobKind;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
}

/**
 * The steps the pipeline is expected to run, shown before anything has
 * started so the user knows what they just asked for. They are replaced
 * by the real jobs as those appear — the plan is a label, never the
 * source of truth about what ran.
 */
function plannedPipelineSteps(startKind: JobKind): PipelineStepView[] {
  const from = AUTO_PIPELINE_ORDER.indexOf(startKind);
  const kinds = from < 0 ? [startKind] : AUTO_PIPELINE_ORDER.slice(from);
  return kinds.map((kind) => ({ kind, status: "pending", progress: 0 }));
}

function mergePipelineStep(
  steps: PipelineStepView[],
  job: { kind: JobKind; status: string; progress: number }
): PipelineStepView[] {
  const status: PipelineStepView["status"] =
    job.status === "queued" ? "pending" : (job.status as PipelineStepView["status"]);
  const updated = { kind: job.kind, status, progress: job.progress };
  const index = steps.findIndex((step) => step.kind === job.kind);
  if (index < 0) return [...steps, updated];
  return steps.map((step, i) => (i === index ? updated : step));
}

export function StudioSection({
  initialProject,
  onSave,
  projectId,
  publicDemo = false,
  publicTrial,
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
  /** Forwarded to SourceIngestPanel so an import is associated with and persisted to this project. */
  projectId?: string;
  /** Public landing-page demonstration: visible without an account, but read-only. */
  publicDemo?: boolean;
  /**
   * Set when this project belongs to an anonymous public-trial actor (the
   * server said so). Trial operations run for real, within the trial's
   * limits, and never open AccountGate.
   */
  publicTrial?: PublicTrialInfo;
}) {
  const isPublicDemo = publicDemo;
  const isPublicTrial = Boolean(publicTrial) && !publicDemo;
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
  const [selectedProviderId, setSelectedProviderId] = useState("");
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

  const [pipelineStatus, setPipelineStatus] = useState<AnalyzeStatus>("idle");
  const [pipelineMessage, setPipelineMessage] = useState<string | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepView[]>([]);

  const [downloadStatus, setDownloadStatus] = useState<AnalyzeStatus>("idle");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [showAccountGate, setShowAccountGate] = useState(false);

  const [trialNotice, setTrialNotice] = useState<string | null>(null);
  const [trialRightsChecked, setTrialRightsChecked] = useState(false);
  /** Free-text name or email the human signs the rights attestation with. Never an auth token. */
  const [rightsSignature, setRightsSignature] = useState("");
  const [rightsStatus, setRightsStatus] = useState<AnalyzeStatus>("idle");
  const [rightsMessage, setRightsMessage] = useState<string | null>(null);

  function requireAccountForCustomization() {
    if (isPublicTrial) {
      // A trial request only comes back unauthenticated once the trial has
      // expired: say so instead of offering an account dialog.
      setTrialNotice("L'essai public a expiré : ce projet et ses fichiers sont supprimés. Revenez à l'accueil pour recommencer.");
      return;
    }
    setShowAccountGate(true);
  }

  /**
   * Rights confirmation + export authorization, persisted right away so the
   * worker sees it.
   *
   * Offered on every real project, not only on the public trial. The export
   * gate refuses every render until a human has signed this, so restricting
   * the control to trials left an ordinary project asking for a
   * confirmation it gave no way to provide — the render button simply
   * stayed blocked forever.
   *
   * A trial visitor has no account to name, so the attestation records the
   * trial itself. Everyone else signs with their own name or email, which
   * is what lands in `workflow.rights.confirmedBy`.
   */
  function rightsSignatureValue(): string {
    return isPublicTrial ? "Visiteur de l'essai public (sans compte)" : rightsSignature.trim();
  }

  const canConfirmRights = trialRightsChecked && rightsSignatureValue().length > 0;

  async function handleConfirmRights() {
    if (!onSave || !canConfirmRights) return;
    const nextWorkflow = authorizeExport(confirmRights(workflow, rightsSignatureValue()));
    setRightsStatus("loading");
    setRightsMessage("Enregistrement de la confirmation…");
    const result = await onSave({ ...initialProject, title, source, workflow: nextWorkflow, segments, updatedAt: new Date().toISOString() });
    if (result.ok) {
      setWorkflow(nextWorkflow);
      setRightsStatus("success");
      setRightsMessage(
        isPublicTrial ? "Droits confirmés : le rendu de test est autorisé." : "Droits confirmés : l'export est autorisé."
      );
    } else {
      setRightsStatus("error");
      setRightsMessage(result.error ?? "La confirmation n'a pas pu être enregistrée.");
    }
  }



  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcript-providers")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        const options = parseProviderListResponse(json);
        if (options.length > 0) setProviderOptions(options);
        // Preselect a provider that can actually run, so the first click works.
        setSelectedProviderId((current) =>
          options.some((p) => p.id === current && p.configured)
            ? current
            : options.find((p) => p.configured)?.id ?? ""
        );
      })
      .catch(() => {
        // The studio must stay usable even if this informational request
        // fails; transcription is then simply reported as unavailable.
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
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
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

  /** Project preview (trial): source and bounds are resolved server-side from the owned project. */
  async function handleProjectPreview() {
    if (!projectId || !selectedSegment) return;
    setPreviewStatus("loading");
    setPreviewMessage("Génération de l'aperçu (filigrane, résolution réduite)…");
    setPreviewUrl(null);
    try {
      const res = await fetch("/api/preview-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, segmentId: selectedSegment.id }),
      });
      if (res.status === 401) {
        setPreviewStatus("idle");
        setPreviewMessage(null);
        requireAccountForCustomization();
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setPreviewStatus("error");
        setPreviewMessage(json?.error ?? "Aperçu indisponible.");
        return;
      }
      setPreviewUrl(json.url);
      setPreviewStatus("success");
      setPreviewMessage(`Aperçu avec filigrane prêt (expire à ${new Date(json.expiresAt).toLocaleTimeString("fr-FR")}).`);
    } catch {
      setPreviewStatus("error");
      setPreviewMessage("Impossible de contacter le serveur d'aperçu.");
    }
  }
  function updateSegment(id: string, updater: (segment: Segment) => Segment) {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    setSegments((prev) => prev.map((s) => (s.id === id ? rescoreSegment(updater(s)) : s)));
  }

  /**
   * Trimming a clip on the timeline. The bounds are only the visible part
   * of it: retimeSegment also re-slices the burned-in words, rescores the
   * clip for its new length and re-fits its effect plan — otherwise a
   * trimmed clip would keep the subtitles and the score of the cut it no
   * longer is, and its plan would fail validation on save.
   */
  function handleRetimeSegment(segmentId: string, bounds: { startSec: number; endSec: number }) {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    setDirty(true);
    setSegments((previous) =>
      previous.map((segment) =>
        segment.id === segmentId
          ? retimeSegment(segment, { ...bounds, transcript: initialProject.transcript })
          : segment
      )
    );
  }

  function handleSplitSegment(segmentId: string, atSec: number) {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    const segment = segments.find((s) => s.id === segmentId);
    if (!segment) return;

    const stamp = Date.now();
    const halves = splitSegment(segment, atSec, {
      transcript: initialProject.transcript,
      idFor: (half) => `${segment.id}-${half}-${stamp}`,
    });
    if (!halves) return;

    setDirty(true);
    setSegments((previous) => previous.flatMap((s) => (s.id === segmentId ? halves : [s])));
    setSelectedSegmentId(halves[0].id);
  }

  function handleDeleteSegment(segmentId: string) {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    const segment = segments.find((s) => s.id === segmentId);
    if (!segment) return;
    if (!window.confirm(`Supprimer le clip « ${segment.title} » ? Cette action n'est pas annulable.`)) {
      return;
    }

    setDirty(true);
    setSegments((previous) => {
      const remaining = previous.filter((s) => s.id !== segmentId);
      if (segmentId === selectedSegmentId) setSelectedSegmentId(remaining[0]?.id ?? "");
      return remaining;
    });
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

  /**
   * `resegment` re-cuts the project from its transcript, replacing the
   * segments it already has. It is a separate, confirmed action rather than
   * a flag on the normal analysis run, because it discards hand edits —
   * and it carries its own idempotency key, since a plain re-cut would
   * otherwise be deduplicated against the first analysis and appear to do
   * nothing.
   */
  async function handleAnalyze(options: { resegment?: boolean } = {}) {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    const resegment = options.resegment === true;
    if (resegment && segments.length > 0) {
      const confirmed = window.confirm(
        `Re-découper remplace les ${segments.length} segment(s) actuels, y compris vos retouches de texte et de cadrage. Continuer ?`
      );
      if (!confirmed) return;
    }
    setAnalyzeStatus("loading");
    setAnalyzeMessage(resegment ? "Re-découpage en cours…" : "Analyse en cours…");
    try {
      if (projectId) {
        const job = await runJob(
          {
            projectId,
            kind: "analysis",
            payload: resegment ? { resegment: true } : {},
            idempotencyKey: resegment
              ? `analysis:${projectId}:${source.id}:resegment:${Date.now()}`
              : `analysis:${projectId}:${source.id}`,
          },
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
    } catch (err) {
      setAnalyzeStatus("error");
      setAnalyzeMessage(failureMessage(err, "Impossible de contacter le serveur d'analyse."));
    }
  }

  async function handleTranscribe() {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
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
    } catch (err) {
      setTranscribeStatus("error");
      setTranscribeMessage(failureMessage(err, "Impossible de contacter le serveur de transcription."));
    }
  }

  async function handleTrack() {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
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

  /**
   * The one-button path: paste a URL, get framed, subtitled candidate
   * clips. It enqueues the first step the project still needs and lets
   * the server chain the rest (see lib/jobs/chain), then follows every
   * step so the user watches the real pipeline instead of a spinner.
   *
   * It starts from the download when the source is a YouTube URL with no
   * file yet, and from the transcription when the media is already there
   * — the same chain, entered where this project actually stands.
   */
  async function handleRunPipeline() {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
    if (!projectId) return;

    const startKind: JobKind = source.localFilePath ? "transcription" : "download";
    if (startKind === "download" && !source.youtubeUrl) {
      setPipelineStatus("error");
      setPipelineMessage("Aucun média ni URL YouTube sur ce projet : importez une source d'abord.");
      return;
    }
    if (segments.length > 0) {
      const confirmed = window.confirm(
        `Le traitement automatique re-découpe le projet et remplace les ${segments.length} segment(s) actuels, y compris vos retouches. Continuer ?`
      );
      if (!confirmed) return;
    }

    setPipelineStatus("loading");
    setPipelineMessage("Traitement automatique en cours…");
    setPipelineSteps(plannedPipelineSteps(startKind));

    try {
      const steps = await runPipeline(
        {
          projectId,
          kind: startKind,
          payload: startKind === "transcription" ? { providerId: selectedProviderId } : {},
          pipeline: {
            providerId: selectedProviderId,
            trackProvider: trackProviderId,
            // The whole point of the automatic run is to produce the clips;
            // an existing hand-edited cut was confirmed away just above.
            resegment: true,
          },
          idempotencyKey: `pipeline:${projectId}:${source.id}:${Date.now()}`,
        },
        {
          onStep: (job) =>
            setPipelineSteps((previous) => mergePipelineStep(previous, job)),
        }
      );

      const failed = steps.find((step) => step.status !== "succeeded");
      if (failed) {
        setPipelineStatus("error");
        setPipelineMessage(
          `${PIPELINE_STEP_LABELS[failed.kind]} : ${failed.errorMessage ?? "étape interrompue"}. Les étapes suivantes n'ont pas été lancées.`
        );
        return;
      }
      setPipelineStatus("success");
      setPipelineMessage("Traitement terminé : les clips candidats sont prêts à être édités.");
      window.location.reload();
    } catch (err) {
      setPipelineStatus("error");
      setPipelineMessage(failureMessage(err, "Impossible de contacter le serveur pour le traitement automatique."));
    }
  }

  async function handleRender() {
    if (isPublicDemo) {
      requireAccountForCustomization();
      return;
    }
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

  const trialBanner = isPublicTrial && publicTrial ? (
    <div className="space-y-2">
      <PublicTrialNotice limits={publicTrial.limits} expiresAt={publicTrial.expiresAt} />
      {trialNotice && (
        <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs text-rose-300">
          {trialNotice}
        </p>
      )}
    </div>
  ) : null;

  const hasMedia = Boolean(source.localFilePath);
  const hasConfiguredProvider = providerOptions.some((p) => p.configured);
  /**
   * Analysis is what turns a transcript into the project's first segment
   * (see the `analysis` handler in src/lib/jobs/handlers.ts), so it needs
   * one or the other to work on.
   */
  const canAnalyze = isPublicDemo || segments.length > 0 || Boolean(initialProject.transcript);

  /**
   * Shared by the "no segment yet" view and the full studio below. A
   * project whose media is already downloaded has to be able to reach
   * transcription and analysis from either one: those two jobs are what
   * create its first segment, and keeping them only in the full studio
   * made a freshly downloaded project a dead end.
   */
  const sourceCard = (
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
  );

  const analysisControls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => handleAnalyze()}
          disabled={analyzeStatus === "loading" || !canAnalyze}
          className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {analyzeStatus === "loading"
            ? "Analyse…"
            : // On a real project this scores the project's own transcript; only
              // the no-project demo runs on the canned demonstration script.
              projectId
              ? "Lancer l'analyse"
              : "Lancer l'analyse (démo déterministe)"}
        </button>
        {projectId && canAnalyze && segments.length > 0 && (
          <button
            type="button"
            onClick={() => handleAnalyze({ resegment: true })}
            disabled={analyzeStatus === "loading"}
            className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Re-découper depuis le transcript
          </button>
        )}
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
      {!canAnalyze && (
        <p className="text-[11px] text-zinc-500">
          Transcrivez d&apos;abord le média : l&apos;analyse travaille sur le transcript pour produire
          le premier segment.
        </p>
      )}
    </div>
  );

  /**
   * The automatic run, offered above the step-by-step controls: the same
   * jobs, in the order they have to happen, without the user having to
   * know that order. The manual buttons stay right below it — re-running
   * one step on an edited project is a normal thing to want, and the
   * pipeline would re-cut everything.
   */
  const pipelinePanel = projectId ? (
    <div
      data-testid="auto-pipeline-panel"
      className="space-y-3 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5"
    >
      <div>
        <h3 className="text-sm font-semibold text-amber-200">Traitement automatique</h3>
        <p className="text-[11px] text-zinc-400">
          {hasMedia
            ? "Transcrit le média, découpe les clips candidats, les classe, puis cadre chacun sur le visage détecté."
            : "Télécharge la vidéo, la transcrit, découpe les clips candidats, les classe, puis cadre chacun sur le visage détecté."}{" "}
          Chaque étape est un job : si l&apos;une échoue, les suivantes ne sont pas lancées.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleRunPipeline}
          disabled={
            pipelineStatus === "loading" ||
            !hasConfiguredProvider ||
            (!hasMedia && !source.youtubeUrl)
          }
          className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pipelineStatus === "loading" ? "Traitement en cours…" : "Tout lancer"}
        </button>
        <p
          role="status"
          aria-live="polite"
          aria-label="Statut du traitement automatique"
          className={`text-xs ${
            pipelineStatus === "error"
              ? "text-rose-300"
              : pipelineStatus === "success"
                ? "text-emerald-300"
                : "text-zinc-400"
          }`}
        >
          {pipelineMessage}
        </p>
      </div>
      {pipelineSteps.length > 0 && (
        <ol className="space-y-1 text-xs">
          {pipelineSteps.map((step) => (
            <li key={step.kind} className="flex items-center gap-2">
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  step.status === "succeeded"
                    ? "bg-emerald-400"
                    : step.status === "running"
                      ? "bg-amber-300"
                      : step.status === "failed" || step.status === "cancelled"
                        ? "bg-rose-400"
                        : "bg-zinc-600"
                }`}
              />
              <span className={step.status === "pending" ? "text-zinc-500" : "text-zinc-300"}>
                {PIPELINE_STEP_LABELS[step.kind]}
              </span>
              <span className="text-zinc-600">
                {step.status === "running"
                  ? `${step.progress}%`
                  : step.status === "succeeded"
                    ? "terminé"
                    : step.status === "failed"
                      ? "échec"
                      : step.status === "cancelled"
                        ? "annulé"
                        : "en attente"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!hasConfiguredProvider && (
        <p className="text-[11px] text-zinc-500">
          Le traitement automatique a besoin d&apos;un fournisseur de transcription configuré
          (<code>OPENAI_API_KEY</code> ou <code>ASSEMBLYAI_API_KEY</code>) : sans transcript, il n&apos;y a
          ni découpage ni sous-titres, et PeakCut n&apos;en invente pas.
        </p>
      )}
    </div>
  ) : null;

  const transcriptionPanel = (
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
              {providerOptions.length === 0 && <option value="">Aucun fournisseur disponible</option>}
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
            disabled={(!source.localFilePath && !isPublicDemo) || !hasConfiguredProvider || transcribeStatus === "loading"}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {transcribeStatus === "loading" ? "Transcription…" : "Transcrire ce média"}
          </button>
        </div>
        {!source.localFilePath && !isPublicDemo && (
          <p className="text-[11px] text-zinc-500">
            Importez un média local ci-dessus pour activer la transcription réelle. Les segments de
            démonstration restent inchangés tant qu&apos;aucun média n&apos;a été importé.
          </p>
        )}
        {!hasConfiguredProvider && !isPublicDemo && (
          <p className="text-[11px] text-zinc-500">
            Aucun fournisseur de transcription n&apos;est configuré. Renseignez une clé API
            (<code>OPENAI_API_KEY</code> ou <code>ASSEMBLYAI_API_KEY</code>) côté serveur, puis
            redémarrez-le. PeakCut ne fabrique jamais de transcript à la place.
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
  );

  if (!selectedSegment) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <input
            aria-label="Titre du projet"
            type="text"
            readOnly={isPublicDemo}
            onClick={isPublicDemo ? requireAccountForCustomization : undefined}
            value={title}
            onChange={(e) => {
              if (isPublicDemo) {
                requireAccountForCustomization();
                return;
              }
              setTitle(e.target.value);
            }}
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
        {trialBanner}
        {isPublicTrial ? (
          <p className="rounded-xl border border-white/10 px-4 py-3 text-xs text-zinc-500">
            L&apos;import de fichiers locaux est réservé aux comptes ; l&apos;essai public fonctionne à partir d&apos;un lien YouTube.
          </p>
        ) : (
          <SourceIngestPanel
            onIngested={handleIngested}
            projectId={projectId}
            requiresAccount={isPublicDemo}
            onAccountRequired={requireAccountForCustomization}
          />
        )}
        <YoutubeSourcePanel
          projectId={projectId}
          onDownloaded={handleDownloaded}
          requiresAccount={isPublicDemo}
          onAccountRequired={requireAccountForCustomization}
        />
        {hasMedia ? (
          <>
            {sourceCard}
            <p className="rounded-xl border border-white/10 px-4 py-3 text-xs text-zinc-400">
              Média prêt côté serveur. Étape suivante : transcrire ce média, puis lancer
              l&apos;analyse — c&apos;est elle qui produit le premier segment éditable.
            </p>
            {pipelinePanel}
            {transcriptionPanel}
            {analysisControls}
          </>
        ) : source.youtubeUrl ? (
          <>
            {sourceCard}
            <p className="rounded-xl border border-white/10 px-4 py-3 text-xs text-zinc-400">
              Cette URL YouTube est enregistrée mais la vidéo n&apos;est pas encore sur le serveur. Le
              traitement automatique la télécharge et va jusqu&apos;aux clips cadrés.
            </p>
            {pipelinePanel}
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
            Importez un média ou téléchargez une vidéo YouTube pour générer les premiers segments
            éditables.
          </div>
        )}
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
            readOnly={isPublicDemo}
            onClick={isPublicDemo ? requireAccountForCustomization : undefined}
            value={title}
            onChange={(e) => {
              if (isPublicDemo) {
                requireAccountForCustomization();
                return;
              }
              setTitle(e.target.value);
            }}
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

      {trialBanner}
      {isPublicTrial ? (
        <p className="rounded-xl border border-white/10 px-4 py-3 text-xs text-zinc-500">
          L&apos;import de fichiers locaux est réservé aux comptes ; l&apos;essai public fonctionne à partir d&apos;un lien YouTube.
        </p>
      ) : (
        <SourceIngestPanel
          onIngested={handleIngested}
          projectId={projectId}
          requiresAccount={isPublicDemo}
          onAccountRequired={requireAccountForCustomization}
        />
      )}

      <YoutubeSourcePanel
        projectId={projectId}
        onDownloaded={handleDownloaded}
        requiresAccount={isPublicDemo}
        onAccountRequired={requireAccountForCustomization}
      />

      {sourceCard}

      {pipelinePanel}

      {analysisControls}

      {transcriptionPanel}

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
            disabled={(!source.localFilePath && !isPublicDemo) || trackStatus === "loading"}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {trackStatus === "loading" ? "Détection…" : "Détecter le cadrage"}
          </button>
        </div>
        {!source.localFilePath && !isPublicDemo && (
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
        // The source's own duration, not the last clip's end: the stretches
        // nobody kept are part of what the editor needs to see.
        totalDurationSec={Math.max(source.durationSec, 0, ...segments.map((s) => s.endSec))}
        selectedSegmentId={selectedSegmentId}
        onSelect={setSelectedSegmentId}
        readOnly={isPublicDemo}
        onRetime={handleRetimeSegment}
        onSplit={handleSplitSegment}
        onDelete={handleDeleteSegment}
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
              readOnly={isPublicDemo}
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
                  readOnly={isPublicDemo}
                  value={selectedSegment.startSec}
                  onChange={(e) =>
                    // Same path as a timeline drag: bounds alone are never
                    // enough, the words and the plan move with them.
                    handleRetimeSegment(selectedSegment.id, {
                      startSec: Number(e.target.value),
                      endSec: selectedSegment.endSec,
                    })
                  }
                  className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                />
              </label>
              <label className="flex items-center gap-1">
                Fin (s)
                <input
                  type="number"
                  step={0.1}
                  readOnly={isPublicDemo}
                  value={selectedSegment.endSec}
                  onChange={(e) =>
                    handleRetimeSegment(selectedSegment.id, {
                      startSec: selectedSegment.startSec,
                      endSec: Number(e.target.value),
                    })
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
            readOnly={isPublicDemo}
            onChangeWord={(index, patch) =>
              updateSegment(selectedSegment.id, (s) => ({
                ...s,
                words: s.words.map((w, i) => (i === index ? { ...w, ...patch } : w)),
              }))
            }
          />
          <EffectsPanel
            segment={selectedSegment}
            readOnly={isPublicDemo}
            onReadOnlyAttempt={requireAccountForCustomization}
            onChange={(renderPlan) => updateSegment(selectedSegment.id, (s) => ({ ...s, renderPlan }))}
          />
          {/*
            Illustrations need a persisted project: they are stored per
            project and addressed by an asset id the server resolves. The
            landing-page demo has no project, so the panel is simply not
            shown there rather than offered and then refused.
          */}
          {projectId && (
            <IllustrationsPanel
              projectId={projectId}
              segment={selectedSegment}
              readOnly={isPublicDemo}
              onReadOnlyAttempt={requireAccountForCustomization}
              onChange={(renderPlan) => updateSegment(selectedSegment.id, (s) => ({ ...s, renderPlan }))}
              generationAvailable={!isPublicTrial && !isPublicDemo}
            />
          )}
          <VariantPicker
            variants={selectedSegment.variants}
            selectedVariantId={selectedVariantId}
            readOnly={isPublicDemo}
            onSelect={(id) => {
              if (isPublicDemo) {
                requireAccountForCustomization();
                return;
              }
              setSelectedVariantBySegment((prev) => ({ ...prev, [selectedSegment.id]: id }));
            }}
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
        {isPublicDemo && (
          <p className="mb-2 font-semibold">
            Démonstration publique en lecture seule : connectez-vous pour importer un média,
            modifier le texte, le timing ou le cadrage, lancer les traitements et conserver vos
            changements.
          </p>
        )}
        Mode validation humaine actif : aucun export ni aucune publication n&apos;est déclenché
        automatiquement. Les droits sur la source doivent être confirmés par un humain avant tout
        export.
      </div>
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{isPublicTrial ? "Rendu de test (essai public)" : "Export MP4"}</h3>
            <p className="mt-1 text-xs text-zinc-500">
              {isPublicTrial
                ? `Rendu exécuté par le worker et vérifié par FFprobe, ${publicTrial?.limits.maxRenders ?? 0} maximum. Il reste sur le serveur et est supprimé à l'expiration de l'essai : aucun téléchargement final sans compte.`
                : "Le rendu est exécuté par le worker et vérifié par FFprobe."}
            </p>
          </div>
          <button type="button" onClick={handleRender} disabled={(!projectId && !isPublicDemo) || renderStatus === "loading"} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50">
            {renderStatus === "loading" ? "Rendu…" : isPublicTrial ? "Lancer le rendu de test" : "Lancer le rendu"}
          </button>
        </div>
        {(isPublicTrial || (Boolean(projectId) && !isPublicDemo)) && (
          <div className="mt-3 space-y-2 rounded-lg border border-white/10 p-3 text-xs text-zinc-300">
            {workflow.rights.confirmed && workflow.phase === "export_authorized" ? (
              <p className="text-emerald-300">
                {isPublicTrial
                  ? "Droits confirmés pour cette source : rendu de test autorisé."
                  : `Droits confirmés pour cette source par « ${workflow.rights.confirmedBy} »${
                      workflow.rights.confirmedAt ? ` le ${formatDate(workflow.rights.confirmedAt)}` : ""
                    } : export autorisé.`}
              </p>
            ) : (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={trialRightsChecked}
                    onChange={(e) => setTrialRightsChecked(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    {isPublicTrial ? (
                      <>
                        Je confirme détenir les droits sur cette source, ou être autorisé à l&apos;utiliser, et
                        j&apos;autorise ce rendu de test. Rien n&apos;est publié.
                      </>
                    ) : (
                      <>
                        Je confirme détenir les droits sur cette source, ou être autorisé à l&apos;utiliser, et
                        j&apos;autorise l&apos;export local de ce projet. Rien n&apos;est publié.
                      </>
                    )}
                  </span>
                </label>
                {!isPublicTrial && (
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-400">
                      Signature (nom ou email) — conservée telle quelle dans le projet, jamais un secret
                    </span>
                    <input
                      type="text"
                      value={rightsSignature}
                      onChange={(e) => setRightsSignature(e.target.value)}
                      placeholder="Votre nom ou email"
                      aria-label="Signature de la confirmation des droits"
                      className="w-full max-w-sm rounded-lg border border-white/15 bg-zinc-950/60 px-2 py-1.5 text-zinc-100"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={handleConfirmRights}
                  disabled={!canConfirmRights || rightsStatus === "loading"}
                  className="rounded-lg border border-amber-400/50 px-3 py-1.5 font-semibold text-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPublicTrial ? "Confirmer les droits" : "Confirmer les droits et autoriser l'export"}
                </button>
              </>
            )}
            {rightsMessage && (
              <p role="status" className={rightsStatus === "error" ? "text-rose-300" : "text-zinc-400"}>
                {rightsMessage}
              </p>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className={`mt-3 text-xs ${renderStatus === "error" ? "text-rose-300" : renderStatus === "success" ? "text-emerald-300" : "text-zinc-500"}`}>
          {renderMessage ??
            (isPublicDemo
              ? "Connexion requise pour lancer un rendu réel. Validation humaine obligatoire avant export."
              : "Validation humaine obligatoire avant export.")}
        </p>
      </div>

      {isPublicTrial && projectId && source.localFilePath && (
        <div data-testid="trial-preview-panel" className="space-y-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Aperçu de l&apos;essai</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Basse résolution avec filigrane PeakCut, {PROJECT_PREVIEW_MAX_DURATION_SEC}s maximum depuis le début du
              segment sélectionné, nombre d&apos;aperçus limité pendant l&apos;essai.
            </p>
          </div>
          <button
            type="button"
            onClick={handleProjectPreview}
            disabled={previewStatus === "loading"}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewStatus === "loading" ? "Génération…" : "Générer l'aperçu"}
          </button>
          {previewUrl && (
            <video data-testid="trial-preview-video" src={previewUrl} controls className="max-h-64 w-full rounded-lg bg-black" />
          )}
          <p role="status" aria-live="polite" className={`text-xs ${previewStatus === "error" ? "text-rose-300" : "text-zinc-500"}`}>
            {previewMessage}
          </p>
        </div>
      )}

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

      {showAccountGate && !isPublicTrial && (
        <AccountGate
          callbackUrl={
            isPublicDemo
              ? PUBLIC_DEMO_CALLBACK_URL
              : typeof window !== "undefined"
                ? relativeUrlOf(window.location)
                : "/"
          }
          onClose={() => setShowAccountGate(false)}
        />
      )}
    </div>
  );
}
