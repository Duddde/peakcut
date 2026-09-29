import { describe, expect, it, vi } from "vitest";
import {
  downloadYoutubeVideo,
  YoutubeDownloadValidationError,
  YOUTUBE_SOURCE_CONFIDENCE,
} from "./downloadYoutubeVideo";
import { VideoDownloadError, type VideoDownloader, type VideoDownloadResult } from "./videoDownloader";

function fakeDownloader(overrides: Partial<VideoDownloadResult> = {}) {
  const download = vi.fn(
    async (): Promise<VideoDownloadResult> => ({
      storedPath: "/srv/peakcut/.data/downloads/abc/dQw4w9WgXcQ.mp4",
      sizeBytes: 12_345_678,
      title: "Une conférence de 12 minutes",
      durationSec: 720,
      videoId: "dQw4w9WgXcQ",
      ...overrides,
    })
  );
  return { download } satisfies VideoDownloader & { download: typeof download };
}

describe("downloadYoutubeVideo", () => {
  it("builds a youtube Source pointing at the real downloaded file", async () => {
    const downloader = fakeDownloader();

    const result = await downloadYoutubeVideo(
      { url: "https://youtu.be/dQw4w9WgXcQ" },
      downloader,
      { now: () => "2026-01-01T00:00:00.000Z", probeDurationSec: async () => 718.4 }
    );

    expect(result.source.type).toBe("youtube");
    expect(result.source.youtubeUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.source.localFilePath).toBe("/srv/peakcut/.data/downloads/abc/dQw4w9WgXcQ.mp4");
    expect(result.source.title).toBe("Une conférence de 12 minutes");
    expect(result.source.originTimestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(result.source.confidence).toBe(YOUTUBE_SOURCE_CONFIDENCE);
    expect(result.videoId).toBe("dQw4w9WgXcQ");
    expect(result.sizeBytes).toBe(12_345_678);
  });

  it("downloads the normalized URL, not the raw one the user pasted", async () => {
    const downloader = fakeDownloader();

    await downloadYoutubeVideo(
      { url: "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s" },
      downloader
    );

    expect(downloader.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
    );
  });

  it("prefers the real ffprobe duration over the one YouTube reported", async () => {
    const result = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader(), {
      probeDurationSec: async () => 718.4,
    });
    expect(result.source.durationSec).toBe(718.4);
  });

  it("keeps the metadata duration when the probe fails, rather than losing the download", async () => {
    const result = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader(), {
      probeDurationSec: async () => {
        throw new Error("ffprobe absent");
      },
    });
    expect(result.source.durationSec).toBe(720);
  });

  it("ignores a nonsensical probe result", async () => {
    const result = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader(), {
      probeDurationSec: async () => 0,
    });
    expect(result.source.durationSec).toBe(720);
  });

  it("returns a fresh workflow: downloading a source authorizes no export", async () => {
    const result = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader());

    expect(result.workflow.phase).toBe("analysis_preview");
    expect(result.workflow.rights.confirmed).toBe(false);
    expect(result.workflow.rights.confirmedBy).toBeNull();
    expect(result.workflow.publicationPolicy).toBe("publication_never_implicit");
  });

  it("rejects a playlist, a channel and a non-YouTube host before downloading anything", async () => {
    const downloader = fakeDownloader();

    for (const url of [
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/@someChannel",
      "https://vimeo.com/123456",
      "not a url at all",
    ]) {
      await expect(downloadYoutubeVideo({ url }, downloader)).rejects.toBeInstanceOf(
        YoutubeDownloadValidationError
      );
    }
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it("forwards progress and cancellation to the downloader untouched", async () => {
    const downloader = fakeDownloader();
    const onProgress = vi.fn();
    const controller = new AbortController();

    await downloadYoutubeVideo(
      { url: "https://youtu.be/dQw4w9WgXcQ", onProgress, signal: controller.signal },
      downloader
    );

    expect(downloader.download).toHaveBeenCalledWith(
      expect.objectContaining({ onProgress, signal: controller.signal })
    );
  });

  it("lets a download failure through as-is instead of masking it", async () => {
    const downloader: VideoDownloader = {
      download: async () => {
        throw new VideoDownloadError("video-unavailable", "Vidéo privée.");
      },
    };

    await expect(
      downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, downloader)
    ).rejects.toBeInstanceOf(VideoDownloadError);
  });

  it("gives every downloaded source its own id", async () => {
    const a = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader());
    const b = await downloadYoutubeVideo({ url: "https://youtu.be/dQw4w9WgXcQ" }, fakeDownloader());
    expect(a.source.id).not.toBe(b.source.id);
  });
});
