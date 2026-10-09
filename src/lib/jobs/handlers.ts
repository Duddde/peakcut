import path from "node:path";
import { mkdir, rm, rmdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { Project, Segment } from "@/lib/domain/types";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { listTranscriptProviders } from "@/lib/transcript/registry";
import type { TranscriptProvider } from "@/lib/transcript/TranscriptProvider";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { deriveCategories } from "@/lib/analysis/deriveCategories";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import { buildDefaultVariants } from "@/lib/domain/defaultVariants";
import { verifyExport } from "@/lib/ffmpeg/verifyExport";
import { exportSegment } from "@/lib/ffmpeg/exportSegment";
import { getExportBlockReasons } from "@/lib/workflow/exportGate";
import { StableCenterFrameTracker } from "@/lib/tracking/StableCenterFrameTracker";
import { LocalSubjectTracker } from "@/lib/tracking/LocalSubjectTracker";
import { AutoSubjectDetectionEngine } from "@/lib/tracking/AutoSubjectDetectionEngine";
import { deriveCropFromTrack } from "@/lib/tracking/deriveCropFromTrack";
import type { FrameTracker } from "@/lib/tracking/types";
import { downloadYoutubeVideo } from "@/lib/youtube/downloadYoutubeVideo";
import {
  createYtDlpDownloader,
  DEFAULT_DOWNLOAD_LIMITS,
  readDownloaderEnvConfig,
  type VideoDownloader,
  type VideoDownloadLimits,
} from "@/lib/youtube/videoDownloader";
import { PUBLIC_TRIAL_LIMITS, type PublicTrialLimits } from "@/lib/publicTrial/config";
import { getProjectTrialStatus } from "@/lib/publicTrial/TrialActorRepository";
import type { JobHandler, JobHandlers } from "./worker";

type TrackProviderId = "local-subject" | "stable-center-fallback";

export type TrackerFactory = (providerId: TrackProviderId) => FrameTracker;

function defaultTrackerFactory(providerId: TrackProviderId): FrameTracker {
  if (providerId === "stable-center-fallback") {
    return new StableCenterFrameTracker();
  }
  return new LocalSubjectTracker(new AutoSubjectDetectionEngine());
}

export interface DefaultJobHandlersDeps {
  db: DatabaseSync;
  /** Base directory rendered clips are written under (a per-job .mp4 is created inside it). */
  exportsBaseDir: string;
  /** Base directory downloaded sources are written under. Defaults to the PEAKCUT_DOWNLOADS_DIR / .data/downloads convention. */
  downloadsBaseDir?: string;
  providers?: TranscriptProvider[];
  trackerFactory?: TrackerFactory;
  /** Injected in tests; defaults to the real yt-dlp-backed downloader. */
  videoDownloader?: VideoDownloader;
  /** Injected in tests; defaults to a yt-dlp downloader with the trial's limits and no cookies. */
  trialVideoDownloader?: VideoDownloader;
  trialLimits?: PublicTrialLimits;
  now?: () => number;
}

/**
 * Download limits for a public-trial project: the stricter of the
 * deployment's own limits and the trial's — a trial can never download
 * more than an account would on the same server.
 */
export function trialDownloadLimits(
  base: Partial<VideoDownloadLimits>,
  trial: PublicTrialLimits = PUBLIC_TRIAL_LIMITS
): VideoDownloadLimits {
  const merged = { ...DEFAULT_DOWNLOAD_LIMITS, ...base };
  return {
    ...merged,
    maxDurationSec: Math.min(merged.maxDurationSec, trial.maxDurationSec),
    maxBytes: Math.min(merged.maxBytes, trial.maxBytes),
    downloadTimeoutMs: Math.min(merged.downloadTimeoutMs, trial.downloadTimeoutMs),
  };
}

export class TrialExpiredError extends Error {
  constructor() {
    super("L'essai public associé à ce projet a expiré : le traitement n'est plus exécuté.");
    this.name = "TrialExpiredError";
  }
}

function loadProjectOrThrow(repo: SqliteProjectRepository, projectId: string | null): Project {
  if (!projectId) {
    throw new Error("Ce job doit être associé à un projet.");
  }
  const project = repo.getProjectById(projectId);
  if (!project) {
    throw new Error(`Projet introuvable : "${projectId}".`);
  }
  return project;
}

function requireLocalMedia(project: Project): string {
  if (!project.source.localFilePath) {
    throw new Error(
      "Aucun fichier média disponible pour ce projet : importez un média local, ou lancez un job \"download\" pour récupérer la source YouTube."
    );
  }
  return project.source.localFilePath;
}

function findSegmentOrThrow(project: Project, segmentId: string): Segment {
  const segment = project.segments.find((s) => s.id === segmentId);
  if (!segment) {
    throw new Error(`Segment introuvable : "${segmentId}".`);
  }
  return segment;
}

function buildWholeTranscriptSegment(
  projectId: string,
  words: Segment["words"],
  sourceDurationSec: number
): Segment {
  const id = `job-analysis-segment-${Date.now()}`;
  const startSec = 0;
  const lastWordEnd = words[words.length - 1]?.endSec ?? 0;
  const endSec = Math.max(lastWordEnd, sourceDurationSec, 0.1);
  return {
    id,
    projectId,
    title: "Segment transcrit",
    startSec,
    endSec,
    words,
    score: null,
    safeZones: buildDefaultSafeZones(id),
    variants: buildDefaultVariants(id),
  };
}

/**
 * Builds the four real (non-simulated) job handlers dispatched by the
 * worker loop, each a thin wrapper around logic that already exists and is
 * already tested elsewhere (the /api/transcribe, /api/track and
 * /api/export-segment routes, and the deterministic scorer used by
 * /api/analyze) — the job layer adds no new detection/scoring behavior of
 * its own. Every handler fails honestly (a thrown Error, which the worker
 * turns into a retry or terminal failure) rather than silently
 * substituting a fake result when a provider/model isn't configured.
 */
export function createDefaultJobHandlers(deps: DefaultJobHandlersDeps): JobHandlers {
  const projectRepo = new SqliteProjectRepository(deps.db);

  let cachedDownloader: VideoDownloader | null = deps.videoDownloader ?? null;
  let cachedTrialDownloader: VideoDownloader | null = deps.trialVideoDownloader ?? null;
  const nowMs = deps.now ?? (() => Date.now());

  /** Built lazily so a worker that never runs a download job never reads the downloader's env config. */
  function resolveVideoDownloader(): VideoDownloader {
    if (cachedDownloader) return cachedDownloader;
    const env = readDownloaderEnvConfig();
    cachedDownloader = createYtDlpDownloader({
      baseDir: deps.downloadsBaseDir ?? env.baseDir,
      binaryPath: env.binaryPath,
      cookiesPath: env.cookiesPath,
      limits: env.limits,
    });
    return cachedDownloader;
  }

  function resolveTrialVideoDownloader(): VideoDownloader {
    if (cachedTrialDownloader) return cachedTrialDownloader;
    const env = readDownloaderEnvConfig();
    cachedTrialDownloader = createYtDlpDownloader({
      baseDir: deps.downloadsBaseDir ?? env.baseDir,
      binaryPath: env.binaryPath,
      // Never the operator's YouTube cookies: an anonymous visitor must not
      // reach, through the server's sign-in, a video YouTube would refuse them.
      cookiesPath: null,
      limits: trialDownloadLimits(env.limits, deps.trialLimits),
    });
    return cachedTrialDownloader;
  }

  /**
   * Trial status is read from the DB, not from PEAKCUT_PUBLIC_TRIAL: the
   * worker may run with a different environment than the web server, and a
   * trial project must keep its limits (and its expiry) regardless.
   */
  function trialStatusOf(projectId: string | null) {
    return projectId ? getProjectTrialStatus(deps.db, projectId, nowMs()) : "none";
  }

  function refuseExpiredTrial(handler: JobHandler): JobHandler {
    return async (ctx) => {
      if (trialStatusOf(ctx.job.projectId) === "expired") throw new TrialExpiredError();
      return handler(ctx);
    };
  }

  const transcription: JobHandler = async ({ job }) => {
    const project = loadProjectOrThrow(projectRepo, job.projectId);
    const mediaPath = requireLocalMedia(project);
    const payload = job.payload as { providerId?: unknown; languageHint?: unknown };
    if (typeof payload.providerId !== "string") {
      throw new Error("payload.providerId est requis pour un job de transcription.");
    }
    const providers = deps.providers ?? listTranscriptProviders();
    const provider = providers.find((p) => p.id === payload.providerId);
    if (!provider) {
      throw new Error(`Fournisseur de transcription inconnu : "${payload.providerId}".`);
    }
    const languageHint = typeof payload.languageHint === "string" ? payload.languageHint : undefined;
    // No silent success on a misconfigured/unavailable cloud provider: real
    // providers (OpenAI/AssemblyAI) throw TranscriptProviderNotConfiguredError
    // here, which the worker turns into a structured failed/retried job —
    // never a fabricated transcript.
    const transcript = await provider.transcribe({ mediaPath, languageHint });

    if (job.projectId) {
      projectRepo.updateProject(job.projectId, {
        ...project,
        transcript,
        updatedAt: new Date().toISOString(),
      });
    }

    return { providerId: provider.id, transcript };
  };

  /**
   * Rescoring is always applied to each existing segment's own (possibly
   * hand-edited) words/boundaries — never re-sliced from the full
   * transcript — so a prior manual edit in the transcript/segment editor is
   * never silently discarded by running analysis again. The one exception
   * is a project with a transcript but zero segments yet: there, a single
   * whole-transcript candidate segment is created as a starting point
   * (mirroring the client-side buildSegmentFromTranscript helper), since
   * PeakCut has no multi-candidate segmentation model to fall back on.
   */
  const analysis: JobHandler = async ({ job }) => {
    const project = loadProjectOrThrow(projectRepo, job.projectId);
    if (project.segments.length === 0 && !project.transcript) {
      throw new Error(
        "Aucun segment ni transcription disponible pour ce projet : lancez d'abord un job de transcription."
      );
    }

    const baseSegments: Segment[] =
      project.segments.length > 0
        ? project.segments
        : project.transcript
          ? [buildWholeTranscriptSegment(project.id, project.transcript.words, project.source.durationSec)]
          : [];

    const scored = baseSegments.map((segment) => {
      const score = scoreSegment({ words: segment.words, startSec: segment.startSec, endSec: segment.endSec });
      return { ...segment, score, categories: deriveCategories(score.explanation.breakdown) };
    });
    const ranked = [...scored]
      .sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0))
      .map((segment, index) => ({ ...segment, rank: index + 1 }));

    if (job.projectId) {
      projectRepo.updateProject(job.projectId, {
        ...project,
        segments: ranked,
        updatedAt: new Date().toISOString(),
      });
    }

    return { segments: ranked };
  };

  const tracking: JobHandler = async ({ job }) => {
    const project = loadProjectOrThrow(projectRepo, job.projectId);
    const mediaPath = requireLocalMedia(project);
    const payload = job.payload as { provider?: unknown };
    const providerId: TrackProviderId = payload.provider === "stable-center-fallback" ? "stable-center-fallback" : "local-subject";
    const probed = await verifyExport(mediaPath);
    const tracker = (deps.trackerFactory ?? defaultTrackerFactory)(providerId);
    // Real detection is either really run, or fails honestly
    // (SubjectDetectionUnavailableError) — never a silently-substituted
    // centered fallback; see AutoSubjectDetectionEngine.
    const track = await tracker.track({
      sourceWidth: probed.width ?? 1920,
      sourceHeight: probed.height ?? 1080,
      durationSec: probed.durationSec || project.source.durationSec,
      mediaPath,
    });

    const sourceWidth = probed.width ?? 1920;
    const sourceHeight = probed.height ?? 1080;
    let updatedSegments: Segment[] | null = null;
    if (project.segments.length > 0) {
      updatedSegments = project.segments.map((segment) => {
        const atSec = segment.startSec + (segment.endSec - segment.startSec) / 2;
        return {
          ...segment,
          variants: segment.variants.map((variant) => {
            const [w, h] = variant.aspectRatio.split(":").map(Number);
            const crop = deriveCropFromTrack(track, { targetAspect: w / h, sourceWidth, sourceHeight, atSec });
            return { ...variant, crop };
          }),
        };
      });
      if (job.projectId) {
        projectRepo.updateProject(job.projectId, {
          ...project,
          segments: updatedSegments,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return { providerId, track, appliedToSegments: updatedSegments !== null };
  };

  const render: JobHandler = async ({ job, reportProgress }) => {
    const project = loadProjectOrThrow(projectRepo, job.projectId);
    const mediaPath = requireLocalMedia(project);
    const payload = job.payload as { segmentId?: unknown; variantId?: unknown };
    if (typeof payload.segmentId !== "string") {
      throw new Error("payload.segmentId est requis pour un job de rendu.");
    }
    const segment = findSegmentOrThrow(project, payload.segmentId);

    const blockReasons = getExportBlockReasons({
      workflow: project.workflow,
      hasLocalMediaFile: true,
      segmentEndSec: segment.endSec,
      sourceDurationSec: project.source.durationSec,
    });
    if (blockReasons.length > 0) {
      throw new Error(`Export non autorisé : ${blockReasons.join(" ")}`);
    }

    const variant =
      typeof payload.variantId === "string"
        ? segment.variants.find((v) => v.id === payload.variantId)
        : segment.variants[0];

    reportProgress(10);
    const resolvedExportsBase = path.resolve(deps.exportsBaseDir);
    await mkdir(resolvedExportsBase, { recursive: true });
    const outputPath = path.join(resolvedExportsBase, `${job.id}.mp4`);

    const exportResult = await exportSegment({
      inputMediaPath: mediaPath,
      startSec: segment.startSec,
      endSec: segment.endSec,
      outputPath,
      words: segment.words,
      crop: variant?.crop,
    });
    reportProgress(90);

    const verified = await verifyExport(outputPath);
    return {
      outputPath,
      durationSec: verified.durationSec,
      renderApplied: exportResult.renderApplied,
      renderLimitations: exportResult.renderLimitations,
    };
  };

  /**
   * Fetches the project's YouTube source to disk so the rest of the
   * pipeline — transcription, tracking, export — has real bytes to work
   * on. The URL comes from `payload.url` when the caller supplied one,
   * otherwise from the project's own registered source, and is re-validated
   * inside downloadYoutubeVideo before anything is fetched.
   *
   * On success only `source` and `workflow` are replaced, exactly like
   * /api/ingest-media: segments/transcript/timeline/title survive, and the
   * workflow is reset so the rights confirmation and export authorization
   * are re-established for this newly-acquired source rather than inherited
   * from the previous one.
   */
  const download: JobHandler = async ({ job, reportProgress }) => {
    const project = loadProjectOrThrow(projectRepo, job.projectId);
    const payload = job.payload as { url?: unknown };
    const url =
      typeof payload.url === "string" && payload.url.trim().length > 0
        ? payload.url.trim()
        : project.source.youtubeUrl;

    if (!url) {
      throw new Error(
        "Aucune URL YouTube à télécharger : fournissez payload.url ou associez d'abord une source YouTube au projet."
      );
    }

    const isTrial = trialStatusOf(job.projectId) !== "none";

    reportProgress(1);
    const result = await downloadYoutubeVideo(
      { url, onProgress: (percent) => reportProgress(Math.min(99, Math.round(percent))) },
      isTrial ? resolveTrialVideoDownloader() : resolveVideoDownloader(),
      { probeDurationSec: async (storedPath) => (await verifyExport(storedPath)).durationSec }
    );

    if (job.projectId) {
      try {
        if (isTrial && trialStatusOf(job.projectId) !== "active") throw new TrialExpiredError();
        projectRepo.updateProject(job.projectId, {
          ...project,
          source: result.source,
          workflow: result.workflow,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        // The trial expired (or its project was deleted) mid-download: the
        // file has no owner any more, so it must not outlive this job.
        if (isTrial && result.source.localFilePath) {
          await rm(result.source.localFilePath, { force: true }).catch(() => undefined);
          // Non-recursive: only drops the per-download directory once it is empty.
          await rmdir(path.dirname(result.source.localFilePath)).catch(() => undefined);
        }
        throw err;
      }
    }

    reportProgress(100);
    return {
      source: result.source,
      workflow: result.workflow,
      videoId: result.videoId,
      normalizedUrl: result.normalizedUrl,
      sizeBytes: result.sizeBytes,
    };
  };

  return {
    download: refuseExpiredTrial(download),
    transcription: refuseExpiredTrial(transcription),
    analysis: refuseExpiredTrial(analysis),
    tracking: refuseExpiredTrial(tracking),
    render: refuseExpiredTrial(render),
  };
}
