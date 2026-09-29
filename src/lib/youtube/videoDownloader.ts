import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseYtDlpProgressLine, summarizeYtDlpEvents, type YtDlpEvent } from "./parseYtDlpProgress";
import { ProcessLaunchError, runProcess, type ProcessRunner } from "./processRunner";

/**
 * Real video downloader, backed by the `yt-dlp` binary.
 *
 * PeakCut downloads a source only when a user explicitly asks it to, for a
 * single video whose URL they submitted — never a playlist, never a
 * channel sweep, never on a schedule. The rights gate is unchanged and
 * still sits downstream: having the bytes on disk does not authorize an
 * export (see src/lib/workflow/exportGate.ts), which still requires an
 * explicit human rights confirmation.
 *
 * Failure is always honest: a missing binary, an unavailable video, or an
 * over-budget file throws a typed VideoDownloadError. Nothing here ever
 * substitutes a placeholder file for a download that did not happen.
 */

export type VideoDownloadErrorCode =
  /** The yt-dlp binary is not installed or not on PATH. */
  | "downloader-unavailable"
  /** YouTube refused to serve this video (private, removed, geo-blocked, sign-in required…). */
  | "video-unavailable"
  /** A live stream, which has no fixed duration to cut from. */
  | "live-stream"
  /** Longer than the configured maximum. */
  | "too-long"
  /** Bigger than the configured maximum. */
  | "too-large"
  | "timeout"
  | "cancelled"
  /** yt-dlp exited non-zero for a reason that isn't one of the above. */
  | "download-failed";

export class VideoDownloadError extends Error {
  readonly code: VideoDownloadErrorCode;

  constructor(code: VideoDownloadErrorCode, message: string) {
    super(message);
    this.name = "VideoDownloadError";
    this.code = code;
  }
}

export interface VideoDownloadRequest {
  /** A normalized, already-validated single-video URL (see validateYoutubeUrl). */
  url: string;
  /** Called with 0..100 as the download advances. Monotonic. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface VideoDownloadResult {
  /** Absolute path of the downloaded media file on this machine. */
  storedPath: string;
  sizeBytes: number;
  /** Title as reported by YouTube's own metadata — not user-supplied. */
  title: string;
  /** Duration in seconds from the source metadata; callers should still probe the real file. */
  durationSec: number;
  /** YouTube video id, when the metadata reported one. */
  videoId: string | null;
}

export interface VideoDownloader {
  download(request: VideoDownloadRequest): Promise<VideoDownloadResult>;
}

export interface VideoDownloadLimits {
  maxDurationSec: number;
  maxBytes: number;
  /** Wall-clock limit for the metadata probe. */
  metadataTimeoutMs: number;
  /** Wall-clock limit for the download itself. */
  downloadTimeoutMs: number;
}

export const DEFAULT_DOWNLOAD_LIMITS: VideoDownloadLimits = {
  maxDurationSec: 4 * 60 * 60,
  maxBytes: 4 * 1024 * 1024 * 1024,
  metadataTimeoutMs: 60_000,
  downloadTimeoutMs: 45 * 60_000,
};

export interface YtDlpDownloaderOptions {
  /** Base directory downloads are written under; each download gets its own subdirectory inside it. */
  baseDir: string;
  /** Path to the yt-dlp executable. Defaults to `yt-dlp` resolved on PATH. */
  binaryPath?: string;
  /** Optional Netscape-format cookie file, for videos YouTube only serves to a signed-in client. */
  cookiesPath?: string | null;
  limits?: Partial<VideoDownloadLimits>;
  /** Injected for tests; defaults to a real subprocess spawn. */
  runner?: ProcessRunner;
}

/** The only fields this code reads; asked for by name so yt-dlp prints nothing else. */
const METADATA_FIELDS = ["id", "title", "duration", "filesize_approx", "is_live", "live_status"] as const;

interface YtDlpMetadata {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  filesize_approx?: unknown;
  is_live?: unknown;
  live_status?: unknown;
  was_live?: unknown;
}

/** Sidecar files yt-dlp may leave next to the media; never the media itself. */
const NON_MEDIA_EXTENSIONS = new Set([
  ".part",
  ".ytdl",
  ".json",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".description",
  ".txt",
  ".vtt",
  ".srt",
  ".temp",
]);

const UNAVAILABLE_PATTERNS = [
  /video unavailable/i,
  /private video/i,
  /members[- ]only/i,
  /removed by the uploader/i,
  /account associated with this video has been terminated/i,
  /is not available in your country/i,
  /sign in to confirm/i,
  /this video is unavailable/i,
  /requested format is not available/i,
  /age[- ]restricted/i,
];

function classifyStderr(stderr: string): VideoDownloadErrorCode | null {
  if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return "video-unavailable";
  }
  if (/file is larger than max-filesize|max-filesize/i.test(stderr)) {
    return "too-large";
  }
  return null;
}

function firstLine(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  return line && line.length > 0 ? line.slice(0, 300) : fallback;
}

function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} Mo`;
}

/**
 * Accepts the path yt-dlp announced only when it is a real file inside
 * this download's own directory. A path parsed out of a subprocess's
 * output is never allowed to point PeakCut at an arbitrary file on disk,
 * so anything else falls back to scanning the directory we created.
 */
async function resolveAnnouncedPath(announced: string | null, targetDir: string): Promise<string | null> {
  if (!announced) return null;

  const resolved = path.resolve(announced);
  const base = path.resolve(targetDir);
  if (!(resolved + path.sep).startsWith(base + path.sep)) return null;

  try {
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Picks the downloaded media file out of the per-download directory. Used
 * both as the primary path resolver's sanity check and as the fallback
 * when yt-dlp's output did not announce a destination in a form this
 * version of PeakCut recognizes.
 */
async function findDownloadedMediaFile(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  let best: { filePath: string; sizeBytes: number } | null = null;
  for (const entry of entries) {
    if (NON_MEDIA_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    const filePath = path.join(dir, entry);
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) continue;
      if (!best || stats.size > best.sizeBytes) {
        best = { filePath, sizeBytes: stats.size };
      }
    } catch {
      // Raced with yt-dlp's own cleanup; just skip this entry.
    }
  }
  return best?.filePath ?? null;
}

export function createYtDlpDownloader(options: YtDlpDownloaderOptions): VideoDownloader {
  const binaryPath = options.binaryPath ?? "yt-dlp";
  const runner = options.runner ?? runProcess;
  const limits: VideoDownloadLimits = { ...DEFAULT_DOWNLOAD_LIMITS, ...options.limits };
  const resolvedBase = path.resolve(options.baseDir);
  const cookiesArgs = options.cookiesPath ? ["--cookies", options.cookiesPath] : [];

  // --ignore-config keeps a stray ~/.config/yt-dlp/config on the host from
  // silently changing the format, output template, or post-processing this
  // code depends on.
  const commonArgs = ["--ignore-config", "--no-playlist", "--no-warnings", ...cookiesArgs];

  // Prefer an mp4/m4a pair so the merge is a remux rather than a re-encode,
  // and cap the resolution: a 4K master costs minutes of transfer for a crop
  // that ends up at 1080x1920 anyway. Shared with the metadata probe so the
  // size it reports is the size of the format actually about to be
  // downloaded — a 4K source advertises a filesize_approx several times
  // larger than the 1080p rendition this really fetches.
  const formatArgs = ["-S", "res:1080", "-f", "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b"];

  function toDownloadError(err: unknown): VideoDownloadError {
    if (err instanceof VideoDownloadError) return err;
    if (err instanceof ProcessLaunchError) {
      return new VideoDownloadError(
        "downloader-unavailable",
        err.errnoCode === "ENOENT"
          ? `Le téléchargeur vidéo "${binaryPath}" est introuvable sur cette machine. Installez yt-dlp (https://github.com/yt-dlp/yt-dlp) ou renseignez PEAKCUT_YTDLP_PATH.`
          : `Le téléchargeur vidéo "${binaryPath}" n'a pas pu être lancé (${err.errnoCode}). Sous Windows, PEAKCUT_YTDLP_PATH doit pointer vers yt-dlp.exe, pas vers un script .cmd/.bat.`
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return new VideoDownloadError("download-failed", `Le téléchargement a échoué : ${message}`);
  }

  async function fetchMetadata(url: string, signal?: AbortSignal): Promise<YtDlpMetadata> {
    // Only the handful of fields this code reads, not --dump-single-json:
    // a single YouTube video dumps ~150 KB of formats/thumbnails/subtitles,
    // which blew past the runner's capture cap and arrived as truncated,
    // unparseable JSON. This prints ~200 bytes instead.
    const result = await runner(
      binaryPath,
      [
        ...commonArgs,
        ...formatArgs,
        "--skip-download",
        "--print",
        `%(.{${METADATA_FIELDS.join(",")}})#j`,
        url,
      ],
      { timeoutMs: limits.metadataTimeoutMs, signal }
    );

    if (result.cancelled) {
      throw new VideoDownloadError("cancelled", "Téléchargement annulé.");
    }
    if (result.timedOut) {
      throw new VideoDownloadError(
        "timeout",
        "YouTube n'a pas répondu dans le délai imparti lors de la lecture des métadonnées."
      );
    }
    if (result.code !== 0) {
      const code = classifyStderr(result.stderr) ?? "download-failed";
      throw new VideoDownloadError(
        code,
        code === "video-unavailable"
          ? `Cette vidéo n'est pas accessible publiquement : ${firstLine(result.stderr, "YouTube a refusé de la servir.")}`
          : `Impossible de lire les métadonnées de la vidéo : ${firstLine(result.stderr, "erreur inconnue.")}`
      );
    }

    // Parsing a prefix of truncated output would produce either a parse
    // error blamed on the wrong thing, or — worse — a plausible-looking
    // object with fields silently missing.
    if (result.truncated) {
      throw new VideoDownloadError(
        "download-failed",
        "La réponse du téléchargeur a été tronquée : métadonnées inexploitables."
      );
    }

    try {
      return JSON.parse(result.stdout) as YtDlpMetadata;
    } catch {
      throw new VideoDownloadError(
        "download-failed",
        "Les métadonnées renvoyées par le téléchargeur ne sont pas du JSON exploitable."
      );
    }
  }

  function assertDownloadable(metadata: YtDlpMetadata): void {
    if (metadata.is_live === true || metadata.live_status === "is_live" || metadata.live_status === "is_upcoming") {
      throw new VideoDownloadError(
        "live-stream",
        "Ce lien pointe vers un direct : PeakCut ne peut découper qu'une vidéo de durée finie."
      );
    }

    const duration = typeof metadata.duration === "number" ? metadata.duration : null;
    if (duration !== null && duration > limits.maxDurationSec) {
      throw new VideoDownloadError(
        "too-long",
        `La vidéo dure ${formatMinutes(duration)}, au-delà de la limite de ${formatMinutes(limits.maxDurationSec)}.`
      );
    }

    const approxBytes = typeof metadata.filesize_approx === "number" ? metadata.filesize_approx : null;
    if (approxBytes !== null && approxBytes > limits.maxBytes) {
      throw new VideoDownloadError(
        "too-large",
        `La vidéo pèse environ ${formatMegabytes(approxBytes)}, au-delà de la limite de ${formatMegabytes(limits.maxBytes)}.`
      );
    }
  }

  return {
    async download(request: VideoDownloadRequest): Promise<VideoDownloadResult> {
      const targetDir = path.join(resolvedBase, randomUUID());

      try {
        const metadata = await fetchMetadata(request.url, request.signal);
        assertDownloadable(metadata);

        await mkdir(targetDir, { recursive: true });

        const events: YtDlpEvent[] = [];
        let lastReported = -1;

        const result = await runner(
          binaryPath,
          [
            ...commonArgs,
            "--newline",
            "--progress",
            "--no-part",
            "--restrict-filenames",
            "--max-filesize",
            String(limits.maxBytes),
            ...formatArgs,
            "--merge-output-format",
            "mp4",
            "-o",
            path.join(targetDir, "%(id)s.%(ext)s"),
            request.url,
          ],
          {
            timeoutMs: limits.downloadTimeoutMs,
            signal: request.signal,
            onStdoutLine: (line) => {
              const event = parseYtDlpProgressLine(line);
              if (!event) return;
              events.push(event);
              if (event.kind === "progress" && request.onProgress) {
                const percent = summarizeYtDlpEvents(events).percent;
                if (percent > lastReported) {
                  lastReported = percent;
                  request.onProgress(percent);
                }
              }
            },
          }
        );

        if (result.cancelled) {
          throw new VideoDownloadError("cancelled", "Téléchargement annulé.");
        }
        if (result.timedOut) {
          throw new VideoDownloadError(
            "timeout",
            `Le téléchargement a dépassé le délai maximum de ${formatMinutes(limits.downloadTimeoutMs / 1000)}.`
          );
        }
        if (result.code !== 0) {
          const code = classifyStderr(result.stderr) ?? "download-failed";
          throw new VideoDownloadError(
            code,
            `Le téléchargement a échoué : ${firstLine(result.stderr, "yt-dlp s'est arrêté avec une erreur.")}`
          );
        }

        const announced = summarizeYtDlpEvents(events).finalPath;
        const storedPath =
          (await resolveAnnouncedPath(announced, targetDir)) ??
          (await findDownloadedMediaFile(targetDir));

        if (!storedPath) {
          throw new VideoDownloadError(
            "download-failed",
            "yt-dlp s'est terminé sans erreur mais aucun fichier média n'a été trouvé."
          );
        }

        const stats = await stat(storedPath);
        if (stats.size > limits.maxBytes) {
          throw new VideoDownloadError(
            "too-large",
            `Le fichier téléchargé pèse ${formatMegabytes(stats.size)}, au-delà de la limite de ${formatMegabytes(limits.maxBytes)}.`
          );
        }
        if (stats.size === 0) {
          throw new VideoDownloadError("download-failed", "Le fichier téléchargé est vide.");
        }

        request.onProgress?.(100);

        return {
          storedPath,
          sizeBytes: stats.size,
          title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : "Vidéo YouTube",
          durationSec: typeof metadata.duration === "number" && metadata.duration > 0 ? metadata.duration : 0,
          videoId: typeof metadata.id === "string" ? metadata.id : null,
        };
      } catch (err) {
        // A failed download must not leave half a file behind to be
        // mistaken later for a usable source.
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        throw toDownloadError(err);
      }
    },
  };
}

export interface DownloaderEnvConfig {
  baseDir: string;
  binaryPath: string;
  cookiesPath: string | null;
  limits: Partial<VideoDownloadLimits>;
}

/**
 * Reads the downloader's deployment knobs from the environment. Called
 * lazily by the job handler (never at module load), like every other
 * env-backed config in this codebase.
 */
export function readDownloaderEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): DownloaderEnvConfig {
  const limits: Partial<VideoDownloadLimits> = {};

  const maxDuration = Number(env.PEAKCUT_DOWNLOAD_MAX_DURATION_SEC);
  if (Number.isFinite(maxDuration) && maxDuration > 0) limits.maxDurationSec = maxDuration;

  const maxMb = Number(env.PEAKCUT_DOWNLOAD_MAX_MB);
  if (Number.isFinite(maxMb) && maxMb > 0) limits.maxBytes = Math.round(maxMb * 1024 * 1024);

  return {
    baseDir: env.PEAKCUT_DOWNLOADS_DIR ?? path.join(cwd, ".data", "downloads"),
    binaryPath: env.PEAKCUT_YTDLP_PATH ?? "yt-dlp",
    cookiesPath: env.PEAKCUT_YTDLP_COOKIES ?? null,
    limits,
  };
}
