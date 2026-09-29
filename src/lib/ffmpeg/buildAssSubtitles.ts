import type { TranscriptWord } from "@/lib/domain/types";
import { EMOTION_WORDS, HOOK_KEYWORDS, normalizeWord } from "@/lib/scoring/lexicon";

export interface BuildAssOptions {
  videoWidth: number;
  videoHeight: number;
  fontSize?: number;
  marginVertical?: number;
  /**
   * Segment start time in the source media. Word timings in the transcript
   * are absolute to the source; the exported clip starts at 0, so this
   * offset is subtracted from every word's start/end before rendering.
   */
  baseOffsetSec?: number;
  /** #RRGGBB override for the caption fill colour. Falls back to opaque white if absent or invalid. */
  primaryColorHex?: string;
  /** Multiplier applied to the default font size. Ignored when `fontSize` is explicitly set. */
  fontSizeScale?: number;
  /** Multiplier applied to the default vertical margin. Ignored when `marginVertical` is explicitly set. */
  marginVerticalScale?: number;
  /** When true, words matching the scoring hook/emotion lexicon are bolded and enlarged in the burned-in captions. */
  emphasizeKeywords?: boolean;
}

const DEFAULT_ASS_PRIMARY_COLOR = "&H00FFFFFF";
const HEX_COLOR_PATTERN = /^#([0-9A-Fa-f]{6})$/;

/** Converts a #RRGGBB colour to ASS's &H00BBGGRR format (alpha byte fixed at 00 = opaque). */
function hexToAssPrimaryColor(hex: string | undefined): string {
  if (!hex) return DEFAULT_ASS_PRIMARY_COLOR;
  const match = HEX_COLOR_PATTERN.exec(hex);
  if (!match) return DEFAULT_ASS_PRIMARY_COLOR;
  const [, rrggbb] = match;
  const rr = rrggbb.slice(0, 2);
  const gg = rrggbb.slice(2, 4);
  const bb = rrggbb.slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

export function secondsToAssTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const centiseconds = Math.round((clamped - Math.floor(clamped)) * 100);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ");
}

/**
 * Builds a word-by-word ASS subtitle track: each word gets its own Dialogue
 * event covering exactly its spoken time window, centered near the bottom
 * of the frame — the classic short-form "one word at a time" caption style.
 */
/** True when the word (normalized) appears in the scorer's hook or emotion lexicon. */
function isEmphasisWorthy(text: string): boolean {
  const normalized = normalizeWord(text);
  return HOOK_KEYWORDS.includes(normalized) || EMOTION_WORDS.includes(normalized);
}

export function buildAssSubtitles(words: TranscriptWord[], options: BuildAssOptions): string {
  const { videoWidth, videoHeight } = options;
  const defaultFontSize = Math.round(videoHeight * 0.045);
  const defaultMarginVertical = Math.round(videoHeight * 0.12);
  const fontSize = options.fontSize ?? Math.round(defaultFontSize * (options.fontSizeScale ?? 1));
  const marginVertical =
    options.marginVertical ?? Math.round(defaultMarginVertical * (options.marginVerticalScale ?? 1));
  const baseOffsetSec = options.baseOffsetSec ?? 0;
  const primaryColor = hexToAssPrimaryColor(options.primaryColorHex);
  const emphasizeKeywords = options.emphasizeKeywords ?? false;

  const header = `[Script Info]
Title: PeakCut word-by-word captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},${primaryColor},&H000000FF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,60,60,${marginVertical},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const dialogueLines = words
    .filter((w) => w.text.trim().length > 0)
    .map((w) => {
      const start = secondsToAssTimestamp(w.startSec - baseOffsetSec);
      const end = secondsToAssTimestamp(Math.max(w.endSec - baseOffsetSec, w.startSec - baseOffsetSec + 0.05));
      const escaped = escapeAssText(w.text);
      const text =
        emphasizeKeywords && isEmphasisWorthy(w.text) ? `{\\b1\\fscx120\\fscy120}${escaped}{\\r}` : escaped;
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
    });

  return [header, ...dialogueLines].join("\n") + "\n";
}
