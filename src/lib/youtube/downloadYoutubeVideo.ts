import { randomUUID } from "node:crypto";
import type { Source, WorkflowState } from "@/lib/domain/types";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { validateYoutubeUrl } from "./validateYoutubeUrl";
import type { VideoDownloader } from "./videoDownloader";

/**
 * Validate-then-download orchestration for a YouTube source: the URL is
 * structurally validated first (so a playlist, a channel, or a non-YouTube
 * host never reaches the downloader at all), the *normalized* single-video
 * URL is downloaded, and the resulting file is probed with real ffprobe
 * before a Source is built from it.
 *
 * The returned WorkflowState is always a *fresh* one. Downloading a source
 * grants no export right: the human rights confirmation and the explicit
 * export authorization still have to be given for this new source, exactly
 * as they do after a local upload.
 */

export class YoutubeDownloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeDownloadValidationError";
  }
}

export interface DownloadYoutubeVideoInput {
  url: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface DownloadYoutubeVideoDeps {
  now?: () => string;
  /** Real media duration probe (ffprobe). Its failure falls back to the duration YouTube reported. */
  probeDurationSec?: (storedPath: string) => Promise<number>;
}

export interface DownloadYoutubeVideoResult {
  source: Source;
  workflow: WorkflowState;
  videoId: string;
  normalizedUrl: string;
  sizeBytes: number;
}

/**
 * Metadata confidence for a downloaded YouTube source. Below the 1.0 given
 * to a local upload — the title comes from YouTube rather than from the
 * user, and PeakCut cannot verify who holds the rights on it — but well
 * above a bare, never-fetched URL: the file is now really on disk and its
 * duration has really been probed.
 */
export const YOUTUBE_SOURCE_CONFIDENCE = 0.9;

export async function downloadYoutubeVideo(
  input: DownloadYoutubeVideoInput,
  downloader: VideoDownloader,
  deps: DownloadYoutubeVideoDeps = {}
): Promise<DownloadYoutubeVideoResult> {
  const validation = validateYoutubeUrl(input.url);
  if (!validation.ok) {
    throw new YoutubeDownloadValidationError(validation.error);
  }

  const downloaded = await downloader.download({
    url: validation.normalizedUrl,
    onProgress: input.onProgress,
    signal: input.signal,
  });

  let durationSec = downloaded.durationSec;
  if (deps.probeDurationSec) {
    try {
      const probed = await deps.probeDurationSec(downloaded.storedPath);
      if (Number.isFinite(probed) && probed > 0) {
        durationSec = probed;
      }
    } catch {
      // Keep the duration YouTube reported rather than failing an
      // otherwise-successful download over a probe that did not run.
    }
  }

  const now = deps.now ? deps.now() : new Date().toISOString();

  const source: Source = {
    id: randomUUID(),
    type: "youtube",
    youtubeUrl: validation.normalizedUrl,
    localFilePath: downloaded.storedPath,
    title: downloaded.title,
    durationSec,
    originTimestamp: now,
    confidence: YOUTUBE_SOURCE_CONFIDENCE,
  };

  return {
    source,
    workflow: createInitialWorkflow(),
    videoId: validation.videoId,
    normalizedUrl: validation.normalizedUrl,
    sizeBytes: downloaded.sizeBytes,
  };
}
