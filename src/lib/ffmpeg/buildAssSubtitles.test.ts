import { describe, expect, it } from "vitest";
import { buildAssSubtitles, secondsToAssTimestamp } from "./buildAssSubtitles";
import type { TranscriptWord } from "@/lib/domain/types";

function word(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec, speaker: "A", confidence: 0.9 };
}

describe("secondsToAssTimestamp", () => {
  it("formats zero as 0:00:00.00", () => {
    expect(secondsToAssTimestamp(0)).toBe("0:00:00.00");
  });

  it("formats sub-minute values with centiseconds", () => {
    expect(secondsToAssTimestamp(1.5)).toBe("0:00:01.50");
  });

  it("formats values over an hour", () => {
    expect(secondsToAssTimestamp(3661.23)).toBe("1:01:01.23");
  });
});

describe("buildAssSubtitles", () => {
  it("includes an ASS header with matching PlayRes dimensions", () => {
    const ass = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920 });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
  });

  it("emits one Dialogue line per word", () => {
    const words = [word("Bonjour", 0, 0.3), word("le", 0.35, 0.5), word("monde", 0.55, 0.9)];
    const ass = buildAssSubtitles(words, { videoWidth: 1080, videoHeight: 1920 });
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogueLines.length).toBe(3);
  });

  it("uses each word's own start/end time, offset by a base time if provided", () => {
    const words = [word("Un", 10, 10.4), word("deux", 10.5, 11)];
    const ass = buildAssSubtitles(words, {
      videoWidth: 1080,
      videoHeight: 1920,
      baseOffsetSec: 10,
    });
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogueLines[0]).toContain("0:00:00.00");
    expect(dialogueLines[0]).toContain("0:00:00.40");
    expect(dialogueLines[1]).toContain("0:00:00.50");
  });

  it("includes the literal word text in its dialogue line", () => {
    const words = [word("PeakCut", 0, 0.5)];
    const ass = buildAssSubtitles(words, { videoWidth: 1080, videoHeight: 1920 });
    expect(ass).toContain("PeakCut");
  });

  it("escapes ASS-significant characters in word text", () => {
    const words = [word("100%{test}\\path", 0, 0.5)];
    const ass = buildAssSubtitles(words, { videoWidth: 1080, videoHeight: 1920 });
    expect(ass).not.toContain("{test}");
    expect(ass).toContain("100%");
  });

  it("produces a valid header with no dialogue lines for an empty transcript", () => {
    const ass = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920 });
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogueLines.length).toBe(0);
    expect(ass).toContain("[Script Info]");
  });

  it("defaults the primary subtitle colour to opaque white", () => {
    const ass = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920 });
    expect(ass).toContain("&H00FFFFFF");
  });

  it("overrides the primary subtitle colour from a #RRGGBB hex value", () => {
    const ass = buildAssSubtitles([], {
      videoWidth: 1080,
      videoHeight: 1920,
      primaryColorHex: "#FFD24D",
    });
    // ASS colour order is &H00BBGGRR — 0xFFD24D -> BB=4D GG=D2 RR=FF
    expect(ass).toContain("&H004DD2FF");
    expect(ass).not.toContain("&H00FFFFFF");
  });

  it("falls back to the default colour for an invalid hex value instead of producing a broken ASS file", () => {
    const ass = buildAssSubtitles([], {
      videoWidth: 1080,
      videoHeight: 1920,
      primaryColorHex: "not-a-color",
    });
    expect(ass).toContain("&H00FFFFFF");
  });

  it("scales the default font size via fontSizeScale", () => {
    const base = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920 });
    const scaled = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920, fontSizeScale: 1.25 });
    const baseFontSize = Number(/Style: Default,Arial,(\d+),/.exec(base)![1]);
    const scaledFontSize = Number(/Style: Default,Arial,(\d+),/.exec(scaled)![1]);
    expect(scaledFontSize).toBe(Math.round(baseFontSize * 1.25));
  });

  it("scales the default vertical margin via marginVerticalScale", () => {
    const base = buildAssSubtitles([], { videoWidth: 1080, videoHeight: 1920 });
    const scaled = buildAssSubtitles([], {
      videoWidth: 1080,
      videoHeight: 1920,
      marginVerticalScale: 0.5,
    });
    const baseMargin = Number(base.match(/,(\d+),1$/m)![1]);
    const scaledMargin = Number(scaled.match(/,(\d+),1$/m)![1]);
    expect(scaledMargin).toBe(Math.round(baseMargin * 0.5));
  });

  it("lets an explicit fontSize/marginVertical take precedence over the scale multipliers", () => {
    const ass = buildAssSubtitles([], {
      videoWidth: 1080,
      videoHeight: 1920,
      fontSize: 100,
      fontSizeScale: 2,
      marginVertical: 50,
      marginVerticalScale: 5,
    });
    expect(ass).toContain("Style: Default,Arial,100,");
    expect(ass.match(/,(\d+),1$/m)![1]).toBe("50");
  });

  it("emphasizes lexicon hook/emotion words with bold+enlarge ASS override tags when emphasizeKeywords is set", () => {
    const words = [word("incroyable", 0, 0.5), word("chaise", 0.6, 1)];
    const ass = buildAssSubtitles(words, {
      videoWidth: 1080,
      videoHeight: 1920,
      emphasizeKeywords: true,
    });
    const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(lines[0]).toContain("{\\b1");
    expect(lines[0]).toContain("incroyable");
    expect(lines[1]).not.toContain("{\\b1");
  });

  it("does not emphasize any word when emphasizeKeywords is absent or false", () => {
    const words = [word("incroyable", 0, 0.5)];
    const ass = buildAssSubtitles(words, { videoWidth: 1080, videoHeight: 1920 });
    expect(ass).not.toContain("{\\b1");
  });

  it("never lets emphasis override tags leak from word text itself (no ffmpeg/ASS text injection)", () => {
    const words = [word("{\\b1}incroyable{\\r}", 0, 0.5)];
    const ass = buildAssSubtitles(words, { videoWidth: 1080, videoHeight: 1920 });
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    // The literal braces from the attacker-controlled word text must be stripped;
    // any {\b1...} present must come only from our own emphasizeKeywords logic
    // (disabled here), so none should appear at all.
    expect(line).not.toContain("{");
    expect(line).not.toContain("}");
  });
});
