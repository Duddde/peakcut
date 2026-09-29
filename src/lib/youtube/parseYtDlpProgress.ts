/**
 * Pure parser for the line-oriented output `yt-dlp --newline --progress`
 * writes on stdout. Kept separate from the process-spawning downloader so
 * the (fiddly, version-sensitive) text handling is testable without ever
 * running a subprocess or touching the network.
 *
 * Only the lines PeakCut actually acts on are recognized; anything else
 * returns null, which the caller ignores. A yt-dlp version that changes
 * its wording therefore degrades to "no progress reported" / "fall back to
 * scanning the output directory" — never to a crash or a wrong file path.
 */

export type YtDlpEvent =
  /** Download completion percentage of the *current* stream (video and audio are separate streams). */
  | { kind: "progress"; percent: number }
  /** A stream is being written to this path. With separate video+audio streams there is one per stream. */
  | { kind: "destination"; path: string }
  /** Separate streams were muxed into this final path — authoritative when present. */
  | { kind: "merged"; path: string };

const PROGRESS_PATTERN = /^\[download\]\s+(\d+(?:\.\d+)?)%/;
const DESTINATION_PATTERN = /^\[download\]\s+Destination:\s*(\S.*?)\s*$/;
const MERGER_PATTERN = /^\[Merger\]\s+Merging formats into\s+"(.+)"\s*$/;
const ALREADY_DOWNLOADED_PATTERN = /^\[download\]\s+(\S.*?)\s+has already been downloaded\s*$/;

export function parseYtDlpProgressLine(line: string): YtDlpEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const merged = MERGER_PATTERN.exec(trimmed);
  if (merged) {
    return { kind: "merged", path: merged[1] };
  }

  const destination = DESTINATION_PATTERN.exec(trimmed);
  if (destination) {
    return { kind: "destination", path: destination[1] };
  }

  const already = ALREADY_DOWNLOADED_PATTERN.exec(trimmed);
  if (already) {
    return { kind: "destination", path: already[1] };
  }

  const progress = PROGRESS_PATTERN.exec(trimmed);
  if (progress) {
    const percent = Number(progress[1]);
    if (!Number.isFinite(percent)) return null;
    return { kind: "progress", percent: Math.max(0, Math.min(100, percent)) };
  }

  return null;
}

export interface YtDlpOutputSummary {
  /** Highest percentage seen, clamped to 0..100. */
  percent: number;
  /**
   * Best guess at the final media file: the merged path when yt-dlp muxed
   * streams, otherwise the last stream destination. Null when neither was
   * announced, in which case the caller must fall back to inspecting the
   * output directory itself.
   */
  finalPath: string | null;
}

/**
 * Folds a sequence of parsed events into the summary the downloader needs.
 * Progress is monotonic on purpose: yt-dlp restarts at 0% for each stream
 * (video, then audio), and a bar that jumps back to 0 mid-download reads
 * as a failure to a user watching it.
 */
export function summarizeYtDlpEvents(events: Iterable<YtDlpEvent>): YtDlpOutputSummary {
  let percent = 0;
  let merged: string | null = null;
  let lastDestination: string | null = null;

  for (const event of events) {
    if (event.kind === "progress") {
      percent = Math.max(percent, event.percent);
      continue;
    }
    if (event.kind === "merged") {
      merged = event.path;
      continue;
    }
    lastDestination = event.path;
  }

  return { percent, finalPath: merged ?? lastDestination };
}
