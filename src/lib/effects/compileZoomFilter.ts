import type { NormalizedRect } from "@/lib/domain/types";
import type { ZoomKeyframe } from "./types";
import { ZOOM_SCALE_MAX, ZOOM_SCALE_MIN } from "./types";

/**
 * Compiles a RenderPlan's bounded zoom keyframes into a real ffmpeg `crop`
 * filter fragment, animated over time via ffmpeg's own expression
 * evaluator (the `t` variable, in seconds, inside the trimmed segment's
 * timeline — matching how word timestamps are already offset in
 * exportSegment). `crop` is used rather than `zoompan` deliberately:
 * zoompan is designed around still-image slideshows (it needs an `fps`
 * assumption and per-frame duplication bookkeeping that can drift from a
 * real video's actual frame rate); an expression-based `crop` animates
 * smoothly on live video with no frame-rate assumption at all, using only
 * the input's native `in_w`/`in_h`, so the fragment is fully
 * resolution-independent.
 *
 * The zoom "shrinks" the base crop region toward its own center as scale
 * increases (scale=1 → full base crop; scale=1.15 → 1/1.15 of its area),
 * then the caller scales the result back up to the fixed output size —
 * exactly as the existing static crop+scale pipeline already does, just
 * with a crop rectangle that now varies with time instead of being fixed.
 */

export interface CompileZoomFilterParams {
  /** Pre-zoom crop rectangle, normalized to the *source* frame (fractions of in_w/in_h). */
  baseCrop: NormalizedRect;
  zoomKeyframes: ZoomKeyframe[];
}

export interface CompiledZoomFilter {
  filterFragment: string;
  /** True only when the plan's zoom actually changed the output framing (constant or animated, but not a no-op). */
  zoomApplied: boolean;
  notes: string[];
}

const NUMBER_PRECISION = 6;

function fmt(n: number): string {
  return n.toFixed(NUMBER_PRECISION);
}

function staticCropFragment(crop: NormalizedRect): string {
  return `crop=w='in_w*${fmt(crop.width)}':h='in_h*${fmt(crop.height)}':x='in_w*${fmt(crop.x)}':y='in_h*${fmt(crop.y)}'`;
}

function dedupeAndSort(keyframes: ZoomKeyframe[]): ZoomKeyframe[] {
  const byTime = new Map<number, ZoomKeyframe>();
  for (const kf of keyframes) {
    byTime.set(kf.tSec, kf);
  }
  return [...byTime.values()].sort((a, b) => a.tSec - b.tSec);
}

function buildPiecewiseScaleExpr(points: ZoomKeyframe[]): string {
  let expr = fmt(points[points.length - 1].scale);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const span = b.tSec - a.tSec;
    const interp =
      span > 0
        ? `(${fmt(a.scale)}+(${fmt(b.scale - a.scale)})*(t-${fmt(a.tSec)})/${fmt(span)})`
        : fmt(b.scale);
    expr = `if(lt(t,${fmt(b.tSec)}),${interp},${expr})`;
  }
  return expr;
}

export function compileZoomFilter(params: CompileZoomFilterParams): CompiledZoomFilter {
  const { baseCrop, zoomKeyframes } = params;
  const notes: string[] = [];

  const points = dedupeAndSort(zoomKeyframes);

  for (const p of points) {
    if (!(p.scale >= ZOOM_SCALE_MIN && p.scale <= ZOOM_SCALE_MAX) || !Number.isFinite(p.scale)) {
      notes.push(
        `Image clé de zoom hors bornes [${ZOOM_SCALE_MIN}, ${ZOOM_SCALE_MAX}] (t=${p.tSec}s, scale=${p.scale}) : cadrage statique de repli appliqué.`
      );
      return { filterFragment: staticCropFragment(baseCrop), zoomApplied: false, notes };
    }
  }

  if (points.length === 0) {
    notes.push("Aucune image clé de zoom fournie : cadrage statique appliqué.");
    return { filterFragment: staticCropFragment(baseCrop), zoomApplied: false, notes };
  }

  const allFlatAtOne = points.every((p) => p.scale === ZOOM_SCALE_MIN);
  if (allFlatAtOne) {
    notes.push("Le plan ne définit aucun zoom (toutes les échelles valent 1) : cadrage statique appliqué.");
    return { filterFragment: staticCropFragment(baseCrop), zoomApplied: false, notes };
  }

  const allEqual = points.every((p) => p.scale === points[0].scale);
  const scaleExpr =
    points.length === 1 || allEqual
      ? fmt(points[0].scale)
      : `clip(${buildPiecewiseScaleExpr(points)},${fmt(ZOOM_SCALE_MIN)},${fmt(ZOOM_SCALE_MAX)})`;

  const w = `in_w*(${fmt(baseCrop.width)})/(${scaleExpr})`;
  const h = `in_h*(${fmt(baseCrop.height)})/(${scaleExpr})`;
  const x = `in_w*(${fmt(baseCrop.x)}+(${fmt(baseCrop.width)})*(1-1/(${scaleExpr}))/2)`;
  const y = `in_h*(${fmt(baseCrop.y)}+(${fmt(baseCrop.height)})*(1-1/(${scaleExpr}))/2)`;

  return {
    filterFragment: `crop=w='${w}':h='${h}':x='${x}':y='${y}'`,
    zoomApplied: true,
    notes,
  };
}
