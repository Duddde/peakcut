import type { PerspectiveMove } from "./types";
import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  PERSPECTIVE_AMOUNT_MAX,
  PERSPECTIVE_AMOUNT_MIN,
  PERSPECTIVE_DIRECTIONS,
  PERSPECTIVE_EVAL_FPS,
  PERSPECTIVE_INSET_MAX,
  PERSPECTIVE_PROFILES,
  perspectiveAxisOf,
} from "./types";

/**
 * Compiles a RenderPlan's 3D moves into a real ffmpeg `perspective`
 * filter, animated over the clip.
 *
 * How the 3D works, since nothing else in the chain does anything like
 * it. `perspective` with `sense=source` takes four points *in the frame*
 * and sends them to the four corners of the output. Give it the frame's
 * own corners and nothing happens. Give it a trapezoid — one edge pulled
 * in, the opposite edge left whole — and the output shows that trapezoid
 * stretched into a rectangle, which is exactly what a flat plane rotated
 * in space projects to: the pulled-in edge covers less source over the
 * same screen height, so it reads as the edge that came closer. The
 * transform is a homography, the same projective map a real camera
 * applies; the tilt is not simulated with a squeeze.
 *
 * Two properties are deliberate. The quadrilateral is always *inside* the
 * frame, so every output pixel is sampled from real source pixels — a
 * tilt never shows a black wedge or a replicated edge, which is what
 * `sense=destination` would give. And at rest the quadrilateral is the
 * frame itself, so a clip outside every move's window renders exactly
 * what it rendered before 3D moves existed.
 *
 * The one awkward part is time. `perspective` is the only filter here
 * whose expressions cannot read `t`; it exposes the frame counter `on`
 * instead. So the fragment pins the rate with an `fps` filter of its own
 * and converts seconds to frames — see PERSPECTIVE_EVAL_FPS for why that
 * is better than probing the source.
 */

export interface CompilePerspectiveFilterParams {
  moves: PerspectiveMove[];
  /** Frames per second the chain is pinned to; the `on` counter is read against it. */
  evalFps?: number;
}

export interface CompiledPerspectiveFilter {
  /**
   * The fragment to insert in the video chain (it carries its own `fps`
   * filter), or null when there is nothing to apply — in which case the
   * caller must leave the chain untouched rather than insert an identity
   * filter.
   */
  filterFragment: string | null;
  /** How many moves actually drive the compiled filter; 0 when the frame stays flat. */
  movesApplied: number;
  notes: string[];
}

const NUMBER_PRECISION = 6;
const EPSILON = 1e-6;

function fmt(n: number): string {
  return n.toFixed(NUMBER_PRECISION);
}

/**
 * 3D moves are compiled or dropped as a whole, never one by one.
 *
 * A plan reaching here has normally passed validateRenderPlan already, so
 * this is the second line of defence. It is all-or-nothing for the same
 * reason framing is: a chain built from the half of the list that looked
 * sane would tilt the clip at moments nobody chose, which reads as a
 * deliberate edit. A flat frame reads as no effect, which is the truth.
 */
function sanitizeMoves(moves: PerspectiveMove[]): { moves: PerspectiveMove[]; notes: string[] } {
  if (moves.length === 0) return { moves: [], notes: [] };

  const reject = (reason: string) => ({
    moves: [],
    notes: [`Effets 3D ignorés (${reason}) : image plate conservée sur tout le clip.`],
  });

  if (moves.length > MAX_PERSPECTIVE_MOVES_PER_PLAN) {
    return reject(`${moves.length} mouvements, maximum ${MAX_PERSPECTIVE_MOVES_PER_PLAN}`);
  }

  const sorted = [...moves].sort((a, b) => a.startSec - b.startSec);
  for (const move of sorted) {
    if (![move.startSec, move.endSec, move.amount].every(Number.isFinite)) {
      return reject(`valeur non finie dans le mouvement "${move.id}"`);
    }
    if (move.startSec < 0 || move.endSec <= move.startSec) {
      return reject(`intervalle invalide dans le mouvement "${move.id}"`);
    }
    if (!PERSPECTIVE_DIRECTIONS.includes(move.direction)) {
      return reject(`direction inconnue dans le mouvement "${move.id}"`);
    }
    if (!PERSPECTIVE_PROFILES.includes(move.profile)) {
      return reject(`profil inconnu dans le mouvement "${move.id}"`);
    }
    if (move.amount < PERSPECTIVE_AMOUNT_MIN || move.amount > PERSPECTIVE_AMOUNT_MAX) {
      return reject(
        `intensité hors bornes [${PERSPECTIVE_AMOUNT_MIN}, ${PERSPECTIVE_AMOUNT_MAX}] dans le mouvement "${move.id}"`
      );
    }
  }

  // Only same-axis overlaps are a problem: the expression for one axis
  // resolves a frame to exactly one tilt, so two moves fighting over it
  // would let branch order decide. Across axes an overlap is a feature —
  // a horizontal and a vertical tilt compose into a diagonal one.
  for (const axis of ["horizontal", "vertical"] as const) {
    const onAxis = sorted.filter((move) => perspectiveAxisOf(move.direction) === axis);
    for (let i = 1; i < onAxis.length; i++) {
      if (onAxis[i].startSec < onAxis[i - 1].endSec - EPSILON) {
        return reject(
          `les mouvements "${onAxis[i - 1].id}" et "${onAxis[i].id}" se chevauchent sur le même axe`
        );
      }
    }
  }

  return { moves: sorted, notes: [] };
}

/**
 * How far into the move we are, as an ffmpeg expression in [0, 1].
 *
 * Frames rather than seconds because `perspective` cannot read `t`; the
 * caller has pinned the rate so the conversion is exact.
 */
function progressExpr(move: PerspectiveMove, evalFps: number): string {
  const startFrame = Math.round(move.startSec * evalFps);
  const endFrame = Math.round(move.endSec * evalFps);
  const span = Math.max(1, endFrame - startFrame);
  return `(on-${startFrame})/${span}`;
}

/**
 * The shape of the tilt across the window.
 *
 * `swing` goes out and comes back, so it starts and ends flat and can sit
 * anywhere in a clip without a pop. `settle` starts at full tilt and
 * eases flat — it belongs right after a cut, where the pop is the point.
 * `lift` is its mirror, tipping away from flat, which only reads well at
 * the end of a clip. Squaring rather than `pow()` keeps the expression
 * short and within the characters validateFilterGraph allows.
 */
function profileExpr(move: PerspectiveMove, evalFps: number): string {
  const u = progressExpr(move, evalFps);
  switch (move.profile) {
    case "swing":
      return `sin(PI*(${u}))`;
    case "settle":
      return `(1-(${u}))*(1-(${u}))`;
    case "lift":
      return `(${u})*(${u})`;
  }
}

/** Positive tilts the near edge to the left (or the top); negative, to the right (or the bottom). */
function signedAmplitude(move: PerspectiveMove): number {
  const magnitude = move.amount * PERSPECTIVE_INSET_MAX;
  return move.direction === "left" || move.direction === "up" ? magnitude : -magnitude;
}

/**
 * The signed inset for one axis as a piecewise function of `on`: the
 * active move's tilt inside its window, and a flat 0 everywhere else.
 * Returning the literal "0" when the axis carries no move is what lets
 * the caller emit bare corner constants instead of a dead expression.
 */
function axisExpr(moves: PerspectiveMove[], evalFps: number): string {
  let expr = "0";
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i];
    const startFrame = Math.round(move.startSec * evalFps);
    const endFrame = Math.round(move.endSec * evalFps);
    const signal = `${fmt(signedAmplitude(move))}*${profileExpr(move, evalFps)}`;
    expr = `if(gte(on,${startFrame})*lt(on,${endFrame}),${signal},${expr})`;
  }
  return expr;
}

interface AxisCorners {
  /** The inset applied at the "low" edge (left, or top). */
  near: string;
  /** The inset applied at the "high" edge (right, or bottom). */
  far: string;
}

/**
 * The two insets an axis contributes, each clamped at 0 so one expression
 * can drive both edges: a positive tilt eats into the near edge and
 * leaves the far one whole, a negative tilt does the opposite.
 */
function axisCorners(expr: string): AxisCorners {
  return { near: `max(${expr},0)`, far: `max(-(${expr}),0)` };
}

export function compilePerspectiveFilter(
  params: CompilePerspectiveFilterParams
): CompiledPerspectiveFilter {
  const evalFps = params.evalFps ?? PERSPECTIVE_EVAL_FPS;
  const sanitized = sanitizeMoves(params.moves);
  if (sanitized.moves.length === 0) {
    return { filterFragment: null, movesApplied: 0, notes: sanitized.notes };
  }

  const horizontal = sanitized.moves.filter((move) => perspectiveAxisOf(move.direction) === "horizontal");
  const vertical = sanitized.moves.filter((move) => perspectiveAxisOf(move.direction) === "vertical");

  // A horizontal tilt pulls a vertical edge in, so it moves the y of the
  // corners; a vertical tilt moves their x. An axis with no move stays a
  // bare constant rather than an expression evaluating to zero on every
  // frame of the clip.
  const h = axisExpr(horizontal, evalFps);
  const v = axisExpr(vertical, evalFps);

  const yCorners = h === "0" ? null : axisCorners(h);
  const xCorners = v === "0" ? null : axisCorners(v);

  const x0 = xCorners ? `W*(${xCorners.near})/2` : "0";
  const x1 = xCorners ? `W*(1-(${xCorners.near})/2)` : "W";
  const x2 = xCorners ? `W*(${xCorners.far})/2` : "0";
  const x3 = xCorners ? `W*(1-(${xCorners.far})/2)` : "W";

  const y0 = yCorners ? `H*(${yCorners.near})/2` : "0";
  const y1 = yCorners ? `H*(${yCorners.far})/2` : "0";
  const y2 = yCorners ? `H*(1-(${yCorners.near})/2)` : "H";
  const y3 = yCorners ? `H*(1-(${yCorners.far})/2)` : "H";

  const corners = [
    `x0='${x0}'`,
    `y0='${y0}'`,
    `x1='${x1}'`,
    `y1='${y1}'`,
    `x2='${x2}'`,
    `y2='${y2}'`,
    `x3='${x3}'`,
    `y3='${y3}'`,
  ].join(":");

  return {
    filterFragment: `fps=${evalFps},perspective=${corners}:sense=source:eval=frame`,
    movesApplied: sanitized.moves.length,
    notes: sanitized.notes,
  };
}
