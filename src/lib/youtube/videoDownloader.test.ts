import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createYtDlpDownloader,
  readDownloaderEnvConfig,
  VideoDownloadError,
  type VideoDownloadErrorCode,
} from "./videoDownloader";
import { ProcessLaunchError, type ProcessRunner, type ProcessRunOptions } from "./processRunner";

const URL_UNDER_TEST = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const DEFAULT_METADATA = {
  id: "dQw4w9WgXcQ",
  title: "Une conférence de 12 minutes",
  duration: 720,
};

function outputDirFromArgs(args: string[]): string {
  const template = args[args.indexOf("-o") + 1];
  return path.dirname(template);
}

interface FakeRunnerOptions {
  metadata?: Record<string, unknown>;
  metadataResult?: Partial<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    truncated: boolean;
  }>;
  downloadResult?: Partial<{ code: number | null; stderr: string; timedOut: boolean; cancelled: boolean }>;
  /** Lines the fake yt-dlp "prints" on stdout while downloading. */
  stdoutLines?: (outputDir: string) => string[];
  /** Files the fake yt-dlp leaves behind, as { relative name -> contents }. */
  writes?: (outputDir: string) => Record<string, string>;
}

/**
 * Stands in for the yt-dlp subprocess. It receives the real argv the
 * downloader builds, writes real files into the real target directory, and
 * emits real progress lines — so everything under test (argument building,
 * metadata gating, progress reporting, output resolution, cleanup) is the
 * production code path. Only the network and the binary are absent.
 */
function fakeRunner(options: FakeRunnerOptions = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];

  const runner: ProcessRunner = async (command, args, runOptions: ProcessRunOptions = {}) => {
    calls.push({ command, args });

    if (args.includes("--skip-download")) {
      return {
        code: 0,
        stdout: JSON.stringify({ ...DEFAULT_METADATA, ...options.metadata }),
        stderr: "",
        timedOut: false,
        cancelled: false,
        truncated: false,
        ...options.metadataResult,
      };
    }

    const outputDir = outputDirFromArgs(args);
    const files = options.writes
      ? options.writes(outputDir)
      : { "dQw4w9WgXcQ.mp4": "fake mp4 payload" };
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(outputDir, name), contents);
    }

    const lines = options.stdoutLines
      ? options.stdoutLines(outputDir)
      : [
          `[download] Destination: ${path.join(outputDir, "dQw4w9WgXcQ.mp4")}`,
          "[download]  25.0% of 10.00MiB at 1.00MiB/s ETA 00:08",
          "[download] 100% of 10.00MiB in 00:10",
        ];
    for (const line of lines) runOptions.onStdoutLine?.(line);

    return {
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      truncated: false,
      ...options.downloadResult,
    };
  };

  return { runner, calls };
}

async function expectDownloadError(
  promise: Promise<unknown>,
  code: VideoDownloadErrorCode
): Promise<VideoDownloadError> {
  const error = await promise.then(
    () => null,
    (err) => err
  );
  expect(error).toBeInstanceOf(VideoDownloadError);
  expect((error as VideoDownloadError).code).toBe(code);
  return error as VideoDownloadError;
}

describe("createYtDlpDownloader", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-download-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("downloads a video and reports its real on-disk size and YouTube metadata", async () => {
    const { runner } = fakeRunner();
    const downloader = createYtDlpDownloader({ baseDir, runner });

    const result = await downloader.download({ url: URL_UNDER_TEST });

    expect(result.storedPath.endsWith("dQw4w9WgXcQ.mp4")).toBe(true);
    expect(result.storedPath.startsWith(path.resolve(baseDir))).toBe(true);
    expect(result.sizeBytes).toBe("fake mp4 payload".length);
    expect(result.title).toBe("Une conférence de 12 minutes");
    expect(result.durationSec).toBe(720);
    expect(result.videoId).toBe("dQw4w9WgXcQ");
  });

  it("never lets yt-dlp fetch more than the single submitted video", async () => {
    const { runner, calls } = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });

    for (const call of calls) {
      expect(call.args).toContain("--no-playlist");
      expect(call.args).toContain("--ignore-config");
      expect(call.args.at(-1)).toBe(URL_UNDER_TEST);
    }
  });

  it("gives each download its own directory so two downloads never collide", async () => {
    const { runner } = fakeRunner();
    const downloader = createYtDlpDownloader({ baseDir, runner });

    const first = await downloader.download({ url: URL_UNDER_TEST });
    const second = await downloader.download({ url: URL_UNDER_TEST });

    expect(path.dirname(first.storedPath)).not.toBe(path.dirname(second.storedPath));
  });

  it("reports monotonic progress and always finishes at 100", async () => {
    const { runner } = fakeRunner({
      stdoutLines: (dir) => [
        `[download] Destination: ${path.join(dir, "dQw4w9WgXcQ.f137.mp4")}`,
        "[download]  40.0% of 10.00MiB",
        "[download] 100% of 10.00MiB",
        `[download] Destination: ${path.join(dir, "dQw4w9WgXcQ.f140.m4a")}`,
        "[download]   0.0% of 1.00MiB",
        "[download]  50.0% of 1.00MiB",
        `[Merger] Merging formats into "${path.join(dir, "dQw4w9WgXcQ.mp4")}"`,
      ],
    });
    const percentages: number[] = [];

    await createYtDlpDownloader({ baseDir, runner }).download({
      url: URL_UNDER_TEST,
      onProgress: (percent) => percentages.push(percent),
    });

    expect(percentages.at(-1)).toBe(100);
    expect([...percentages].sort((a, b) => a - b)).toEqual(percentages);
  });

  it("uses the merged output rather than a leftover per-stream file", async () => {
    const { runner } = fakeRunner({
      writes: () => ({
        "dQw4w9WgXcQ.f140.m4a": "audio only",
        "dQw4w9WgXcQ.mp4": "the real merged output, larger",
      }),
      stdoutLines: (dir) => [`[Merger] Merging formats into "${path.join(dir, "dQw4w9WgXcQ.mp4")}"`],
    });

    const result = await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });
    expect(path.basename(result.storedPath)).toBe("dQw4w9WgXcQ.mp4");
  });

  it("falls back to scanning its own directory when yt-dlp announced no path", async () => {
    const { runner } = fakeRunner({ stdoutLines: () => ["[download] 100% of 10.00MiB"] });

    const result = await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });
    expect(path.basename(result.storedPath)).toBe("dQw4w9WgXcQ.mp4");
  });

  it("ignores sidecar files when scanning for the media file", async () => {
    const { runner } = fakeRunner({
      writes: () => ({
        "dQw4w9WgXcQ.info.json": "x".repeat(5000),
        "dQw4w9WgXcQ.webp": "y".repeat(4000),
        "dQw4w9WgXcQ.mp4": "small but real",
      }),
      stdoutLines: () => [],
    });

    const result = await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });
    expect(path.basename(result.storedPath)).toBe("dQw4w9WgXcQ.mp4");
  });

  it("refuses a path yt-dlp announced outside this download's directory", async () => {
    const escapee = path.join(baseDir, "not-mine.mp4");
    await writeFile(escapee, "a file that is none of this download's business");

    const { runner } = fakeRunner({
      writes: () => ({ "dQw4w9WgXcQ.mp4": "the real output" }),
      stdoutLines: () => [`[Merger] Merging formats into "${escapee}"`],
    });

    const result = await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });
    expect(result.storedPath).not.toBe(escapee);
    expect(path.basename(result.storedPath)).toBe("dQw4w9WgXcQ.mp4");
  });

  it("asks yt-dlp for only the fields it reads, not the full metadata dump", async () => {
    // Regression: --dump-single-json returns ~150 KB for a YouTube video,
    // which overran the runner's capture cap and arrived as truncated,
    // unparseable JSON on the very first real download.
    const { runner, calls } = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });

    const probe = calls[0].args;
    expect(probe).not.toContain("--dump-single-json");
    expect(probe).toContain("--print");
    const template = probe[probe.indexOf("--print") + 1];
    for (const field of ["id", "title", "duration", "filesize_approx", "is_live", "live_status"]) {
      expect(template).toContain(field);
    }
  });

  it("probes with the same format selection it will download, so the reported size is the real one", async () => {
    // A 4K source advertises a filesize_approx several times larger than the
    // 1080p rendition actually fetched; probing with different arguments
    // would reject videos that fit the budget perfectly well.
    const { runner, calls } = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST });

    const formatOf = (args: string[]) => args[args.indexOf("-f") + 1];
    const sortOf = (args: string[]) => args[args.indexOf("-S") + 1];
    expect(formatOf(calls[0].args)).toBe(formatOf(calls[1].args));
    expect(sortOf(calls[0].args)).toBe(sortOf(calls[1].args));
  });

  it("refuses truncated metadata instead of parsing a prefix of it", async () => {
    const { runner } = fakeRunner({
      metadataResult: { stdout: '{"id":"dQw4w9WgXcQ","tit', truncated: true },
    });

    const error = await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "download-failed"
    );
    expect(error.message).toMatch(/tronqu/i);
  });

  it("reports a missing yt-dlp binary as a typed, actionable error", async () => {
    const runner: ProcessRunner = async () => {
      throw new ProcessLaunchError("yt-dlp", "ENOENT");
    };

    const error = await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "downloader-unavailable"
    );
    expect(error.message).toMatch(/Installez yt-dlp/);
  });

  it("distinguishes an unlaunchable binary from a missing one", async () => {
    const runner: ProcessRunner = async () => {
      throw new ProcessLaunchError("yt-dlp", "EINVAL");
    };

    const error = await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "downloader-unavailable"
    );
    expect(error.message).toMatch(/\.cmd\/\.bat/);
    expect(error.message).not.toMatch(/Installez yt-dlp/);
  });

  it("maps YouTube's refusal to a video-unavailable error", async () => {
    const { runner } = fakeRunner({
      metadataResult: { code: 1, stdout: "", stderr: "ERROR: [youtube] abc: Private video. Sign in if you've been granted access" },
    });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "video-unavailable"
    );
  });

  it("refuses a live stream, which has no finite duration to cut from", async () => {
    const { runner, calls } = fakeRunner({ metadata: { is_live: true, duration: null } });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "live-stream"
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses an over-long video before downloading a single byte", async () => {
    const { runner, calls } = fakeRunner({ metadata: { duration: 5 * 60 * 60 } });

    const error = await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner, limits: { maxDurationSec: 60 * 60 } }).download({
        url: URL_UNDER_TEST,
      }),
      "too-long"
    );
    expect(error.message).toMatch(/60 min/);
    // Only the metadata probe ran — the download was never started.
    expect(calls).toHaveLength(1);
    expect(await readdir(baseDir)).toEqual([]);
  });

  it("refuses an over-large video before downloading a single byte", async () => {
    const { runner, calls } = fakeRunner({ metadata: { filesize_approx: 900 * 1024 * 1024 } });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner, limits: { maxBytes: 100 * 1024 * 1024 } }).download({
        url: URL_UNDER_TEST,
      }),
      "too-large"
    );
    expect(calls).toHaveLength(1);
  });

  it("surfaces a timeout as a timeout, not a generic failure", async () => {
    const { runner } = fakeRunner({ downloadResult: { code: null, timedOut: true } });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "timeout"
    );
  });

  it("surfaces a cancellation as a cancellation", async () => {
    const { runner } = fakeRunner({ downloadResult: { code: null, cancelled: true } });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "cancelled"
    );
  });

  it("fails rather than returning a phantom file when yt-dlp downloaded nothing", async () => {
    const { runner } = fakeRunner({ writes: () => ({}), stdoutLines: () => [] });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "download-failed"
    );
  });

  it("rejects an empty file instead of handing back a zero-byte source", async () => {
    const { runner } = fakeRunner({ writes: () => ({ "dQw4w9WgXcQ.mp4": "" }), stdoutLines: () => [] });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "download-failed"
    );
  });

  it("leaves nothing behind on disk when a download fails", async () => {
    const { runner } = fakeRunner({
      writes: () => ({ "dQw4w9WgXcQ.mp4.part": "half a file" }),
      downloadResult: { code: 1, stderr: "ERROR: network died" },
    });

    await expectDownloadError(
      createYtDlpDownloader({ baseDir, runner }).download({ url: URL_UNDER_TEST }),
      "download-failed"
    );
    expect(await readdir(baseDir)).toEqual([]);
  });

  it("passes a cookie file through to yt-dlp only when one is configured", async () => {
    const withCookies = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner: withCookies.runner, cookiesPath: "/etc/peakcut/cookies.txt" }).download({
      url: URL_UNDER_TEST,
    });
    expect(withCookies.calls[0].args).toContain("--cookies");
    expect(withCookies.calls[0].args).toContain("/etc/peakcut/cookies.txt");

    const without = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner: without.runner }).download({ url: URL_UNDER_TEST });
    expect(without.calls[0].args).not.toContain("--cookies");
  });

  it("uses the configured binary path", async () => {
    const { runner, calls } = fakeRunner();
    await createYtDlpDownloader({ baseDir, runner, binaryPath: "/opt/bin/yt-dlp" }).download({
      url: URL_UNDER_TEST,
    });
    expect(calls.every((c) => c.command === "/opt/bin/yt-dlp")).toBe(true);
  });
});

describe("readDownloaderEnvConfig", () => {
  it("falls back to the .data/downloads convention and a PATH-resolved yt-dlp", () => {
    const config = readDownloaderEnvConfig({} as unknown as NodeJS.ProcessEnv, "/srv/peakcut");
    expect(config.baseDir).toBe(path.join("/srv/peakcut", ".data", "downloads"));
    expect(config.binaryPath).toBe("yt-dlp");
    expect(config.cookiesPath).toBeNull();
    expect(config.limits).toEqual({});
  });

  it("reads every override from the environment", () => {
    const config = readDownloaderEnvConfig(
      {
        PEAKCUT_DOWNLOADS_DIR: "/mnt/media",
        PEAKCUT_YTDLP_PATH: "/opt/bin/yt-dlp",
        PEAKCUT_YTDLP_COOKIES: "/etc/peakcut/cookies.txt",
        PEAKCUT_DOWNLOAD_MAX_DURATION_SEC: "600",
        PEAKCUT_DOWNLOAD_MAX_MB: "512",
      } as unknown as NodeJS.ProcessEnv,
      "/srv/peakcut"
    );
    expect(config.baseDir).toBe("/mnt/media");
    expect(config.binaryPath).toBe("/opt/bin/yt-dlp");
    expect(config.cookiesPath).toBe("/etc/peakcut/cookies.txt");
    expect(config.limits).toEqual({ maxDurationSec: 600, maxBytes: 512 * 1024 * 1024 });
  });

  it("ignores unusable override values rather than producing a nonsense limit", () => {
    const config = readDownloaderEnvConfig(
      { PEAKCUT_DOWNLOAD_MAX_DURATION_SEC: "pas-un-nombre", PEAKCUT_DOWNLOAD_MAX_MB: "-3" } as unknown as NodeJS.ProcessEnv,
      "/srv/peakcut"
    );
    expect(config.limits).toEqual({});
  });
});

describe("VideoDownloadError", () => {
  it("carries a machine-readable code alongside its human message", () => {
    const error = new VideoDownloadError("too-long", "trop long");
    expect(error.name).toBe("VideoDownloadError");
    expect(error.code).toBe("too-long");
    expect(error).toBeInstanceOf(Error);
  });
});
