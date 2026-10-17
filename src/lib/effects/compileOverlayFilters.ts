import type { Overlay } from "./types";

/**
 * Compiles a plan's illustrations into a real ffmpeg filter_complex
 * chain: one still image per overlay, scaled into its box, faded in and
 * out, composited over the clip for exactly its window.
 *
 * Two deliberate choices make this robust rather than clever.
 *
 * Each image is fed with `-loop 1` and no input duration, so its frames
 * share the clip's own timeline. `fade`'s `st=` and `overlay`'s
 * `enable='between(t,…)'` then both speak in clip seconds, with no
 * `setpts` shifting and no timestamp alignment to get wrong — and the
 * overlay stream always has a frame available, so `overlay` never waits
 * for one. The output's own `-t` is what bounds the looping image; see
 * exportSegment, where `-t` is an output option.
 *
 * And the image keeps its aspect ratio: `rect` is a *box* it is fitted
 * into (`force_original_aspect_ratio=decrease`) and then centered in,
 * using `overlay`'s own `w`/`h` variables for the scaled size. Stretching
 * a user's illustration to whatever rectangle they dragged would be the
 * easier filter and the wrong one.
 *
 * The file path never enters the filtergraph — it is passed as an `-i`
 * argument, so there is nothing to escape here and no path-shaped value
 * for validateFilterGraph to reject.
 */

export interface OverlayInput {
  overlay: Overlay;
  /** Absolute local path to the image, resolved from the asset store by the caller. */
  filePath: string;
}

export interface CompileOverlayFiltersParams {
  overlays: OverlayInput[];
  outputWidth: number;
  outputHeight: number;
  /** Label of the stream the illustrations are laid over, e.g. "vbase". */
  baseLabel: string;
  /** ffmpeg input index of the first overlay image (the source media is input 0). */
  firstInputIndex: number;
}

export interface CompiledOverlayFilters {
  /** `;`-joined filter_complex fragments, or null when nothing is laid over. */
  chain: string | null;
  /** Label carrying the final video; equals `baseLabel` when no overlay applied. */
  outputLabel: string;
  /** `-loop 1 -i <path>` groups, in input order, to place before the filtergraph. */
  inputArgs: string[];
  appliedCount: number;
  notes: string[];
}

/** Smallest box worth compositing into, in pixels. */
const MIN_BOX_PX = 2;

function fmt(n: number): string {
  return n.toFixed(3);
}

export function compileOverlayFilters(params: CompileOverlayFiltersParams): CompiledOverlayFilters {
  const { overlays, outputWidth, outputHeight, baseLabel, firstInputIndex } = params;
  const notes: string[] = [];
  const fragments: string[] = [];
  const inputArgs: string[] = [];

  let currentLabel = baseLabel;
  let applied = 0;

  overlays.forEach(({ overlay, filePath }) => {
    const boxWidth = Math.round(overlay.rect.width * outputWidth);
    const boxHeight = Math.round(overlay.rect.height * outputHeight);
    if (boxWidth < MIN_BOX_PX || boxHeight < MIN_BOX_PX) {
      notes.push(`Illustration "${overlay.id}" ignorée : sa taille à l'écran serait de moins de ${MIN_BOX_PX} pixels.`);
      return;
    }

    const inputIndex = firstInputIndex + applied;
    inputArgs.push("-loop", "1", "-i", filePath);

    const srcLabel = `ovsrc${applied}`;
    const outLabel = `ovout${applied}`;

    const duration = overlay.endSec - overlay.startSec;
    const fade = Math.min(overlay.fadeSec, duration / 2);
    const fadeFilters =
      fade > 0
        ? [
            `fade=t=in:st=${fmt(overlay.startSec)}:d=${fmt(fade)}:alpha=1`,
            `fade=t=out:st=${fmt(overlay.endSec - fade)}:d=${fmt(fade)}:alpha=1`,
          ]
        : [];

    fragments.push(
      [
        `[${inputIndex}:v]scale=${boxWidth}:${boxHeight}:force_original_aspect_ratio=decrease`,
        "format=rgba",
        `colorchannelmixer=aa=${overlay.opacity.toFixed(3)}`,
        ...fadeFilters,
      ].join(",") + `[${srcLabel}]`
    );

    const x = Math.round(overlay.rect.x * outputWidth);
    const y = Math.round(overlay.rect.y * outputHeight);
    fragments.push(
      `[${currentLabel}][${srcLabel}]overlay=` +
        [
          `x='${x}+(${boxWidth}-w)/2'`,
          `y='${y}+(${boxHeight}-h)/2'`,
          "eof_action=pass",
          `enable='between(t,${fmt(overlay.startSec)},${fmt(overlay.endSec)})'`,
        ].join(":") +
        `[${outLabel}]`
    );

    currentLabel = outLabel;
    applied += 1;
  });

  return {
    chain: fragments.length > 0 ? fragments.join(";") : null,
    outputLabel: currentLabel,
    inputArgs,
    appliedCount: applied,
    notes,
  };
}
