import type { NormalizedRect } from "@/lib/domain/types";
import type { FramingShot, ZoomKeyframe } from "./types";
import { MAX_FRAMING_SHOTS_PER_PLAN, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN } from "./types";

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
 *
 * The plan's `framing` shots move that base rectangle during the clip, so
 * the short can stay on whoever is speaking (see FramingShot). The same
 * single `crop` carries both: the base rectangle becomes a piecewise
 * expression of `t`, and the zoom still shrinks whatever that rectangle
 * is at that instant. One filter rather than two means there is no second
 * resampling step, and no way for the two to disagree about the frame.
 */

export interface CompileZoomFilterParams {
  /** Pre-zoom crop rectangle, normalized to the *source* frame (fractions of in_w/in_h). */
  baseCrop: NormalizedRect;
  zoomKeyframes: ZoomKeyframe[];
  /**
   * Shots the crop follows, clip-relative and normalized to the source
   * frame. Absent or empty means the base crop holds for the whole clip —
   * byte for byte the fragment this compiled before shots existed.
   */
  framing?: FramingShot[];
}

export interface CompiledZoomFilter {
  filterFragment: string;
  /** True only when the plan's zoom actually changed the output framing (constant or animated, but not a no-op). */
  zoomApplied: boolean;
  /** How many framing shots actually drive the compiled crop; 0 when the base crop holds throughout. */
  framingApplied: number;
  notes: string[];
}

const NUMBER_PRECISION = 6;
/**
 * Times need far less precision than fractions of a frame: a shot
 * boundary is a cut, and a thousandth of a second is already under one
 * frame at any realistic rate. Three decimals instead of six also keeps
 * the piecewise expression inside the length validateFilterGraph allows.
 */
const TIME_PRECISION = 3;
const EPSILON = 1e-6;

function fmt(n: number): string {
  return n.toFixed(NUMBER_PRECISION);
}

function fmtTime(n: number): string {
  return n.toFixed(TIME_PRECISION);
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

/**
 * The zoom curve as the first scale plus one ramp per change: each segment
 * between two keyframes adds its difference, spread linearly over its
 * span. A segment that holds the scale adds nothing at all — and that is
 * most of them in a "punch on each speaker change" edit, which nested
 * if() branches spelled out one by one until the expression, repeated in
 * the crop's four parameters, passed the filtergraph limit and the whole
 * animated crop (speaker framing included) fell back to a static one.
 *
 * ffmpeg evaluates the crop's width and height once, at configuration,
 * with `t` undefined (NaN): a ramp would then be NaN and the filter
 * refused. The expression answers the last keyframe's scale there, which
 * is what the previous nested form evaluated to at that moment.
 */
function buildPiecewiseScaleExpr(points: ZoomKeyframe[]): string {
  let expr = fmt(points[0].scale);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const step = b.scale - a.scale;
    if (Math.abs(step) <= EPSILON) continue;
    const span = b.tSec - a.tSec;
    const progress = span > 0 ? `clip((t-${fmt(a.tSec)})/${fmt(span)},0,1)` : `gte(t,${fmt(b.tSec)})`;
    expr += `${step < 0 ? "-" : "+"}${fmt(Math.abs(step))}*${progress}`;
  }
  return `if(isnan(t),${fmt(points[points.length - 1].scale)},${expr})`;
}

interface ResolvedScale {
  /** The zoom scale as an ffmpeg expression, or null when there is no zoom to apply. */
  expr: string | null;
  zoomApplied: boolean;
  notes: string[];
}

/** The zoom half of the job, independent of how the base rectangle is obtained. */
function resolveScale(zoomKeyframes: ZoomKeyframe[]): ResolvedScale {
  const notes: string[] = [];
  const points = dedupeAndSort(zoomKeyframes);

  for (const p of points) {
    if (!(p.scale >= ZOOM_SCALE_MIN && p.scale <= ZOOM_SCALE_MAX) || !Number.isFinite(p.scale)) {
      notes.push(
        `Image clé de zoom hors bornes [${ZOOM_SCALE_MIN}, ${ZOOM_SCALE_MAX}] (t=${p.tSec}s, scale=${p.scale}) : cadrage statique de repli appliqué.`
      );
      return { expr: null, zoomApplied: false, notes };
    }
  }

  if (points.length === 0) {
    notes.push("Aucune image clé de zoom fournie : cadrage statique appliqué.");
    return { expr: null, zoomApplied: false, notes };
  }

  if (points.every((p) => p.scale === ZOOM_SCALE_MIN)) {
    notes.push("Le plan ne définit aucun zoom (toutes les échelles valent 1) : cadrage statique appliqué.");
    return { expr: null, zoomApplied: false, notes };
  }

  const allEqual = points.every((p) => p.scale === points[0].scale);
  const expr =
    points.length === 1 || allEqual
      ? fmt(points[0].scale)
      : `clip(${buildPiecewiseScaleExpr(points)},${fmt(ZOOM_SCALE_MIN)},${fmt(ZOOM_SCALE_MAX)})`;

  return { expr, zoomApplied: true, notes };
}

type RectComponent = "x" | "y" | "width" | "height";

/**
 * Framing is compiled or dropped as a whole, never shot by shot.
 *
 * A plan that reaches here has normally already passed
 * validateRenderPlan, so this is the second line of defence rather than
 * the first — and the reason it is all-or-nothing is that half a framing
 * is not a framing: dropping the one bad shot out of five would leave the
 * crop sitting on the wrong face for that stretch, which reads as a
 * deliberate edit. Falling back to the base crop at least looks like what
 * the clip did before anyone tried to follow a speaker.
 */
function sanitizeFraming(framing: FramingShot[]): { shots: FramingShot[]; notes: string[] } {
  if (framing.length === 0) return { shots: [], notes: [] };

  const reject = (reason: string) => ({
    shots: [],
    notes: [`Cadrage par plans ignoré (${reason}) : cadrage de base appliqué sur tout le clip.`],
  });

  if (framing.length > MAX_FRAMING_SHOTS_PER_PLAN) {
    return reject(`${framing.length} plans, maximum ${MAX_FRAMING_SHOTS_PER_PLAN}`);
  }

  const shots = [...framing].sort((a, b) => a.startSec - b.startSec);
  for (const shot of shots) {
    const { x, y, width, height } = shot.rect;
    const numbers = [shot.startSec, shot.endSec, shot.transitionSec, x, y, width, height];
    if (numbers.some((n) => !Number.isFinite(n))) {
      return reject(`valeur non finie dans le plan "${shot.id}"`);
    }
    if (shot.startSec < 0 || shot.endSec <= shot.startSec) {
      return reject(`intervalle invalide dans le plan "${shot.id}"`);
    }
    if (shot.transitionSec < 0 || shot.transitionSec > shot.endSec - shot.startSec) {
      return reject(`transition invalide dans le plan "${shot.id}"`);
    }
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 1 + EPSILON || y + height > 1 + EPSILON) {
      return reject(`fenêtre hors du cadre source dans le plan "${shot.id}"`);
    }
  }
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].startSec < shots[i - 1].endSec - EPSILON) {
      return reject(`les plans "${shots[i - 1].id}" et "${shots[i].id}" se chevauchent`);
    }
  }

  return { shots, notes: [] };
}

/**
 * One crop component as a piecewise function of `t`.
 *
 * Shots that leave the component unchanged compile to a bare number: on a
 * real speaker switch only x moves (the crop window keeps the output's
 * aspect ratio), so w, h and usually y stay constant and the expression
 * stays short enough for the filtergraph validator to accept it.
 *
 * The first shot drops its lower bound and the last drops its upper one:
 * the clip's real duration is a rounded number of frames, and a last
 * shot that stopped applying at its nominal end would pop back to the
 * base crop for the final frames.
 */
function componentExpr(shots: FramingShot[], component: RectComponent, baseValue: number): string {
  if (!shots.some((shot) => Math.abs(shot.rect[component] - baseValue) > EPSILON)) {
    return fmt(baseValue);
  }

  // Shots that follow each other without a gap — what framing on the
  // camera cuts of an edited show produces, dozens per clip — compile to a
  // sum of steps: the first value, plus each change from the moment it
  // happens, as a jump (a cut) or as a linear ramp over the shot's
  // transition (a pan). Same function as the nested form below, at a
  // fraction of the length and without nesting dozens of if() deep.
  const contiguous = shots.every((shot, i) => i === 0 || Math.abs(shot.startSec - shots[i - 1].endSec) <= EPSILON);
  if (contiguous) {
    let expr = fmt(shots[0].rect[component]);
    for (let i = 1; i < shots.length; i++) {
      const step = shots[i].rect[component] - shots[i - 1].rect[component];
      if (Math.abs(step) <= EPSILON) continue;
      const start = fmtTime(shots[i].startSec);
      const progress =
        shots[i].transitionSec > EPSILON ? `clip((t-${start})/${fmt(shots[i].transitionSec)},0,1)` : `gte(t,${start})`;
      expr += `${step < 0 ? "-" : "+"}${fmt(Math.abs(step))}*${progress}`;
    }
    // Same configuration-time guard as the zoom: a pan's ramp is NaN while
    // `t` is undefined.
    return shots.some((shot) => shot.transitionSec > EPSILON) ? `if(isnan(t),${fmt(shots[0].rect[component])},${expr})` : expr;
  }

  let expr = fmt(baseValue);
  for (let i = shots.length - 1; i >= 0; i--) {
    const shot = shots[i];
    const value = shot.rect[component];
    const previousShot = i > 0 ? shots[i - 1] : null;
    const continuesPrevious = previousShot !== null && previousShot.endSec >= shot.startSec - EPSILON;
    const previousValue = continuesPrevious ? previousShot.rect[component] : baseValue;

    const panning = shot.transitionSec > EPSILON && Math.abs(value - previousValue) > EPSILON;
    const shotExpr = panning
      ? `if(lt(t,${fmtTime(shot.startSec + shot.transitionSec)}),(${fmt(previousValue)}+(${fmt(value - previousValue)})*(t-${fmtTime(shot.startSec)})/${fmt(shot.transitionSec)}),${fmt(value)})`
      : fmt(value);

    const conditions: string[] = [];
    if (shot.startSec > EPSILON) conditions.push(`gte(t,${fmtTime(shot.startSec)})`);
    if (i < shots.length - 1) conditions.push(`lt(t,${fmtTime(shot.endSec)})`);

    expr = conditions.length === 0 ? shotExpr : `if(${conditions.join("*")},${shotExpr},${expr})`;
  }
  return expr;
}

interface CropExpressions {
  w: string;
  h: string;
  x: string;
  y: string;
}

function framedCropFragment(crop: CropExpressions, scaleExpr: string | null): string {
  if (scaleExpr === null) {
    return `crop=w='in_w*(${crop.w})':h='in_h*(${crop.h})':x='in_w*(${crop.x})':y='in_h*(${crop.y})'`;
  }
  const w = `in_w*(${crop.w})/(${scaleExpr})`;
  const h = `in_h*(${crop.h})/(${scaleExpr})`;
  const x = `in_w*((${crop.x})+(${crop.w})*(1-1/(${scaleExpr}))/2)`;
  const y = `in_h*((${crop.y})+(${crop.h})*(1-1/(${scaleExpr}))/2)`;
  return `crop=w='${w}':h='${h}':x='${x}':y='${y}'`;
}

export function compileZoomFilter(params: CompileZoomFilterParams): CompiledZoomFilter {
  const { baseCrop, zoomKeyframes } = params;
  const framing = sanitizeFraming(params.framing ?? []);
  const scale = resolveScale(zoomKeyframes);
  const notes = [...framing.notes, ...scale.notes];

  if (framing.shots.length === 0) {
    // The pre-framing shapes, unchanged: a plain static crop, or the base
    // rectangle shrunk by the zoom expression.
    if (scale.expr === null) {
      return { filterFragment: staticCropFragment(baseCrop), zoomApplied: false, framingApplied: 0, notes };
    }
    const w = `in_w*(${fmt(baseCrop.width)})/(${scale.expr})`;
    const h = `in_h*(${fmt(baseCrop.height)})/(${scale.expr})`;
    const x = `in_w*(${fmt(baseCrop.x)}+(${fmt(baseCrop.width)})*(1-1/(${scale.expr}))/2)`;
    const y = `in_h*(${fmt(baseCrop.y)}+(${fmt(baseCrop.height)})*(1-1/(${scale.expr}))/2)`;
    return {
      filterFragment: `crop=w='${w}':h='${h}':x='${x}':y='${y}'`,
      zoomApplied: true,
      framingApplied: 0,
      notes,
    };
  }

  const shots = framing.shots;
  const fragment = framedCropFragment(
    {
      w: componentExpr(shots, "width", baseCrop.width),
      h: componentExpr(shots, "height", baseCrop.height),
      x: componentExpr(shots, "x", baseCrop.x),
      y: componentExpr(shots, "y", baseCrop.y),
    },
    scale.expr
  );

  return { filterFragment: fragment, zoomApplied: scale.zoomApplied, framingApplied: shots.length, notes };
}
