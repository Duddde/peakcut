import type { MotionCard } from "./types";

/**
 * Claude Motion cards as ASS: styles and animated events added to the
 * clip's subtitle track, which the export and the preview already burn in
 * through libass. Animation uses what ASS itself animates — scale, alpha
 * and position over time (\t, \move, \fad) — so a card needs no extra
 * input, no extra filter and no other render engine, and the preview
 * shows exactly what the export writes.
 *
 * Every size and position is a share of the frame, so the same cards land
 * in the same place at preview resolution (540×960) and in the export
 * (1080×1920). Cards sit in the top or the middle of the frame, never the
 * bottom, where the captions are.
 */

export interface CompileMotionAssOptions {
  videoWidth: number;
  videoHeight: number;
  /** "#RRGGBB" — the card highlight; the caption colour, so the edit keeps one look. */
  accentHex?: string;
}

export interface MotionAss {
  styles: string[];
  events: string[];
}

const DEFAULT_ACCENT = "#FFC21A";
const HEX_PATTERN = /^#([0-9A-Fa-f]{6})$/;

/** "#RRGGBB" and an alpha byte (00 opaque … FF invisible) as an ASS &HAABBGGRR colour. */
function assColor(hex: string, alpha = "00"): string {
  const match = HEX_PATTERN.exec(hex) ?? HEX_PATTERN.exec(DEFAULT_ACCENT)!;
  const rgb = match[1];
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

function timestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const centiseconds = Math.min(99, Math.round((clamped - Math.floor(clamped)) * 100));
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
}

/** Card text is the model's or the editor's: it must never carry ASS override codes. */
function clean(text: string): string {
  return text.replace(/[\\{}]/g, "").replace(/\r?\n/g, " ").trim();
}

/** Pops in from 60 % to a slight overshoot, then settles; `delayMs` after the event starts. */
function popIn(delayMs: number): string {
  return `\\fscx60\\fscy60\\alpha&HFF&\\t(${delayMs},${delayMs + 160},\\fscx106\\fscy106\\alpha&H00&)\\t(${delayMs + 160},${delayMs + 260},\\fscx100\\fscy100)`;
}

/** Slides in from the left while fading in. */
function slideIn(x: number, y: number, delayMs: number, distance: number): string {
  return `\\move(${x - distance},${y},${x},${y},${delayMs},${delayMs + 220})\\alpha&HFF&\\t(${delayMs},${delayMs + 220},\\alpha&H00&)`;
}

const FADE_OUT = "\\fad(0,200)";

/** How many lines a text will wrap to, roughly, at a given size across the usable width. */
function estimateLines(text: string, fontSize: number, usableWidth: number): number {
  const charsPerLine = Math.max(8, Math.floor(usableWidth / (fontSize * 0.56)));
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

export function compileMotionAss(cards: MotionCard[], options: CompileMotionAssOptions): MotionAss {
  if (cards.length === 0) return { styles: [], events: [] };
  const { videoWidth: W, videoHeight: H } = options;
  const accent = options.accentHex && HEX_PATTERN.test(options.accentHex) ? options.accentHex : DEFAULT_ACCENT;

  const titleSize = Math.round(H * 0.05);
  const statSize = Math.round(H * 0.11);
  const detailSize = Math.round(H * 0.03);
  const itemSize = Math.round(H * 0.034);
  const pad = Math.max(2, Math.round(H * 0.012));
  const margin = Math.round(W * 0.08);
  const usableWidth = W - 2 * margin;
  const dark = "&H30101010";
  const white = "&H00FFFFFF";

  // BorderStyle 3 draws an opaque box behind the text: the outline colour
  // (and the back colour, which some renderers use instead) is the box.
  const style = (name: string, size: number, primary: string, box: string, bold: number, italic: number, borderStyle: number, outline: number, shadow: number) =>
    `Style: ${name},Arial,${size},${primary},&H000000FF,${box},${box},${bold},${italic},0,0,100,100,0,0,${borderStyle},${outline},${shadow},8,${margin},${margin},0,1`;
  const styles = [
    style("MotionTitle", titleSize, "&H00101010", assColor(accent, "00"), 1, 0, 3, pad, 0),
    style("MotionQuote", titleSize, white, dark, 1, 1, 3, pad, 0),
    style("MotionStat", statSize, assColor(accent), "&H00101010", 1, 0, 1, Math.max(2, Math.round(H * 0.004)), 2),
    style("MotionDetail", detailSize, white, dark, 0, 0, 3, Math.max(2, Math.round(pad * 0.8)), 0),
    style("MotionItem", itemSize, white, dark, 1, 0, 3, Math.max(2, Math.round(pad * 0.8)), 0),
  ];

  const events: string[] = [];
  const x = Math.round(W / 2);
  const dialogue = (startSec: number, endSec: number, styleName: string, text: string) =>
    `Dialogue: 1,${timestamp(startSec)},${timestamp(endSec)},${styleName},,0,0,0,,${text}`;

  for (const card of [...cards].sort((a, b) => a.startSec - b.startSec)) {
    const top = Math.round(H * (card.position === "top" ? 0.13 : 0.36));
    const text = clean(card.text);
    const detail = card.detail ? clean(card.detail) : "";
    const { startSec, endSec } = card;

    switch (card.kind) {
      case "keyword": {
        events.push(dialogue(startSec, endSec, "MotionTitle", `{\\an8\\pos(${x},${top})${popIn(0)}${FADE_OUT}}${text}`));
        if (detail) {
          const y = top + estimateLines(text, titleSize, usableWidth) * titleSize * 1.25 + pad * 3;
          events.push(dialogue(startSec, endSec, "MotionDetail", `{\\an8${slideIn(x, Math.round(y), 200, Math.round(W * 0.04))}${FADE_OUT}}${detail}`));
        }
        break;
      }
      case "stat": {
        events.push(dialogue(startSec, endSec, "MotionStat", `{\\an8\\pos(${x},${top})${popIn(0)}${FADE_OUT}}${text}`));
        if (detail) {
          const y = top + statSize * 1.15;
          events.push(dialogue(startSec, endSec, "MotionDetail", `{\\an8${slideIn(x, Math.round(y), 250, Math.round(W * 0.04))}${FADE_OUT}}${detail}`));
        }
        break;
      }
      case "quote": {
        events.push(dialogue(startSec, endSec, "MotionQuote", `{\\an8\\pos(${x},${top})${popIn(0)}${FADE_OUT}}« ${text} »`));
        if (detail) {
          const y = top + estimateLines(text, titleSize, usableWidth) * titleSize * 1.25 + pad * 3;
          events.push(dialogue(startSec, endSec, "MotionDetail", `{\\an8${slideIn(x, Math.round(y), 300, Math.round(W * 0.04))}${FADE_OUT}}— ${detail}`));
        }
        break;
      }
      case "list": {
        events.push(dialogue(startSec, endSec, "MotionTitle", `{\\an8\\pos(${x},${top})${popIn(0)}${FADE_OUT}}${text}`));
        let y = top + estimateLines(text, titleSize, usableWidth) * titleSize * 1.25 + pad * 3;
        card.items.forEach((item, i) => {
          // Each point arrives after the previous one, as if counted off.
          events.push(
            dialogue(startSec, endSec, "MotionItem", `{\\an8${slideIn(x, Math.round(y), 250 + i * 350, Math.round(W * 0.05))}${FADE_OUT}}${clean(item)}`)
          );
          y += itemSize * 1.7;
        });
        break;
      }
    }
  }
  return { styles, events };
}
