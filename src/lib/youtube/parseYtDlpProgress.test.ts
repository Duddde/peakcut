import { describe, expect, it } from "vitest";
import { parseYtDlpProgressLine, summarizeYtDlpEvents } from "./parseYtDlpProgress";

describe("parseYtDlpProgressLine", () => {
  it("reads the percentage off a progress line", () => {
    expect(parseYtDlpProgressLine("[download]  12.3% of ~  10.00MiB at  1.00MiB/s ETA 00:10")).toEqual({
      kind: "progress",
      percent: 12.3,
    });
  });

  it("reads a 100% line with no decimals", () => {
    expect(parseYtDlpProgressLine("[download] 100% of 10.00MiB in 00:10")).toEqual({
      kind: "progress",
      percent: 100,
    });
  });

  it("clamps an out-of-range percentage rather than propagating it", () => {
    expect(parseYtDlpProgressLine("[download] 140.0% of 10.00MiB")).toEqual({ kind: "progress", percent: 100 });
  });

  it("reads a stream destination", () => {
    expect(parseYtDlpProgressLine("[download] Destination: /tmp/dl/abc.f137.mp4")).toEqual({
      kind: "destination",
      path: "/tmp/dl/abc.f137.mp4",
    });
  });

  it("reads the merged output path", () => {
    expect(parseYtDlpProgressLine('[Merger] Merging formats into "/tmp/dl/abc.mp4"')).toEqual({
      kind: "merged",
      path: "/tmp/dl/abc.mp4",
    });
  });

  it("treats an already-downloaded file as a destination", () => {
    expect(parseYtDlpProgressLine("[download] /tmp/dl/abc.mp4 has already been downloaded")).toEqual({
      kind: "destination",
      path: "/tmp/dl/abc.mp4",
    });
  });

  it("handles a Windows path with spaces in the merged line", () => {
    expect(parseYtDlpProgressLine('[Merger] Merging formats into "C:\\Users\\me\\My Videos\\abc.mp4"')).toEqual({
      kind: "merged",
      path: "C:\\Users\\me\\My Videos\\abc.mp4",
    });
  });

  it("ignores lines it does not recognize instead of throwing", () => {
    expect(parseYtDlpProgressLine("[youtube] abc: Downloading webpage")).toBeNull();
    expect(parseYtDlpProgressLine("")).toBeNull();
    expect(parseYtDlpProgressLine("   ")).toBeNull();
    expect(parseYtDlpProgressLine("WARNING: something odd")).toBeNull();
  });
});

describe("summarizeYtDlpEvents", () => {
  it("keeps progress monotonic across the video and audio streams", () => {
    const summary = summarizeYtDlpEvents([
      { kind: "progress", percent: 40 },
      { kind: "progress", percent: 100 },
      // yt-dlp restarts at 0% for the second stream.
      { kind: "progress", percent: 0 },
      { kind: "progress", percent: 30 },
    ]);
    expect(summary.percent).toBe(100);
  });

  it("prefers the merged path over the per-stream destinations", () => {
    const summary = summarizeYtDlpEvents([
      { kind: "destination", path: "/tmp/dl/abc.f137.mp4" },
      { kind: "destination", path: "/tmp/dl/abc.f140.m4a" },
      { kind: "merged", path: "/tmp/dl/abc.mp4" },
    ]);
    expect(summary.finalPath).toBe("/tmp/dl/abc.mp4");
  });

  it("falls back to the last destination when nothing was merged", () => {
    const summary = summarizeYtDlpEvents([{ kind: "destination", path: "/tmp/dl/abc.mp4" }]);
    expect(summary.finalPath).toBe("/tmp/dl/abc.mp4");
  });

  it("reports no path at all when yt-dlp announced none", () => {
    expect(summarizeYtDlpEvents([{ kind: "progress", percent: 10 }])).toEqual({ percent: 10, finalPath: null });
  });
});
