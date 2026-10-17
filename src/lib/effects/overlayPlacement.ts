import type { NormalizedRect } from "@/lib/domain/types";

/**
 * Where an illustration sits in the frame, as a few named places rather
 * than four numbers.
 *
 * Dragging a box around a 9:16 preview is the obvious interface and the
 * wrong one to build first: the useful positions on a short are "over the
 * speaker", "in the middle", "above the captions" and "instead of the
 * video", and naming them makes each one correct by construction — in
 * particular, nothing but `full` ever reaches down into the caption area,
 * so an illustration cannot bury the subtitles.
 *
 * `size` is the box width as a fraction of the frame. Height follows so
 * the box is square in pixels (the frame is 1080x1920, hence 0.5625), and
 * the image is fitted inside it without being distorted — see
 * compileOverlayFilters.
 */

export type OverlayPlacement = "top" | "center" | "bottom" | "full";

export const OVERLAY_PLACEMENTS: OverlayPlacement[] = ["top", "center", "bottom", "full"];

export const OVERLAY_SIZE_MIN = 0.2;
export const OVERLAY_SIZE_MAX = 1;
export const OVERLAY_SIZE_DEFAULT = 0.7;

/** A square box in pixels, expressed as fractions of a 1080x1920 frame. */
const HEIGHT_PER_WIDTH = 1080 / 1920;

/**
 * No placement but `full` reaches below this line: it is the top of the
 * subtitle safe zone (see buildDefaultSafeZones), so an illustration can
 * never bury the captions. At the largest size a centered box would end
 * at 0.781, just past it, which is why the limit is applied to every
 * placement rather than only to the bottom one.
 */
const BOTTOM_LIMIT = 0.78;
const TOP_MARGIN = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function placementRect(placement: OverlayPlacement, size = OVERLAY_SIZE_DEFAULT): NormalizedRect {
  if (placement === "full") return { x: 0, y: 0, width: 1, height: 1 };

  const width = clamp(size, OVERLAY_SIZE_MIN, OVERLAY_SIZE_MAX);
  const height = width * HEIGHT_PER_WIDTH;
  const x = (1 - width) / 2;

  const highest = Math.max(0, BOTTOM_LIMIT - height);
  if (placement === "top") return { x, y: Math.min(TOP_MARGIN, highest), width, height };
  if (placement === "center") return { x, y: Math.min((1 - height) / 2, highest), width, height };
  return { x, y: highest, width, height };
}

/** The named place a rectangle is closest to — what the panel shows as selected. */
export function placementOf(rect: NormalizedRect): OverlayPlacement {
  if (rect.width >= 0.99 && rect.height >= 0.99) return "full";

  const candidates: OverlayPlacement[] = ["top", "center", "bottom"];
  let best: OverlayPlacement = "center";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(placementRect(candidate, rect.width).y - rect.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** The size slider's current value for a rectangle. */
export function sizeOf(rect: NormalizedRect): number {
  return clamp(rect.width, OVERLAY_SIZE_MIN, OVERLAY_SIZE_MAX);
}
