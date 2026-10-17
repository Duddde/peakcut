import type { NormalizedRect } from "@/lib/domain/types";
import { placementRect } from "./overlayPlacement";
import {
  MAX_OVERLAYS_PER_PLAN,
  MIN_OVERLAY_DURATION_SEC,
  OVERLAY_FADE_SEC_MAX,
  OVERLAY_FADE_SEC_MIN,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  type Overlay,
  type RenderPlan,
} from "./types";

/**
 * Adding, changing and removing an illustration on a clip.
 *
 * Every function here returns a plan that passes validateRenderPlan, for
 * any input the panel can produce: times are clamped inside the clip,
 * durations never fall below the visible minimum, a fade never outruns
 * half the illustration, and the box always stays in frame. The server
 * re-validates anyway — but a UI that can build a plan the server
 * refuses is a UI that loses the user's work at save time, which is the
 * failure these clamps exist to prevent.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A millisecond of slack when clamping an illustration to the minimum
 * duration. Clamping to exactly MIN_OVERLAY_DURATION_SEC produced spans
 * like 0.2999999999999972 — binary floating point, not a logic error —
 * which the validator rightly refused as too short. Asking for one
 * millisecond more makes the comparison robust without changing anything
 * anyone can see.
 */
const SPAN_MARGIN_SEC = 0.001;

/** The clip length a plan describes: the end of its last cut. */
export function planDurationSec(plan: RenderPlan): number {
  return plan.cuts.reduce((end, cut) => Math.max(end, cut.endSec), 0);
}

export interface DefaultOverlayOptions {
  assetId: string;
  id: string;
  /** Clip length, used to place the illustration inside it. */
  durationSec: number;
  /** How many illustrations the clip already has; each new one starts a little later. */
  index?: number;
}

/**
 * A sensible first placement for a newly added illustration: a few
 * seconds over the speaker, a quarter of the way in, staggered so a
 * second one does not land exactly on the first.
 */
export function defaultOverlayFor(options: DefaultOverlayOptions): Overlay {
  const duration = Math.max(0, options.durationSec);
  const wanted = Math.min(3, Math.max(MIN_OVERLAY_DURATION_SEC, duration / 3));
  const stagger = (options.index ?? 0) * wanted;
  const startSec = clamp(duration / 4 + stagger, 0, Math.max(0, duration - wanted));
  const endSec = Math.min(duration, startSec + wanted);

  return {
    id: options.id,
    assetId: options.assetId,
    startSec,
    endSec,
    rect: placementRect("top"),
    opacity: 1,
    fadeSec: Math.min(0.3, (endSec - startSec) / 2),
  };
}

/** True when the clip can carry another illustration at all. */
export function canAddOverlay(plan: RenderPlan): boolean {
  return plan.overlays.length < MAX_OVERLAYS_PER_PLAN;
}

export function withOverlay(plan: RenderPlan, overlay: Overlay): RenderPlan {
  if (!canAddOverlay(plan)) return plan;
  return { ...plan, overlays: [...plan.overlays, fitOverlay(overlay, planDurationSec(plan))] };
}

export function withoutOverlay(plan: RenderPlan, overlayId: string): RenderPlan {
  return { ...plan, overlays: plan.overlays.filter((overlay) => overlay.id !== overlayId) };
}

export type OverlayPatch = Partial<Pick<Overlay, "startSec" | "endSec" | "opacity" | "fadeSec" | "rect">>;

export function patchOverlay(plan: RenderPlan, overlayId: string, patch: OverlayPatch): RenderPlan {
  const duration = planDurationSec(plan);
  return {
    ...plan,
    overlays: plan.overlays.map((overlay) =>
      overlay.id === overlayId ? fitOverlay({ ...overlay, ...patch }, duration) : overlay
    ),
  };
}

/** The rectangle, brought back inside the frame without changing its size. */
function fitRect(rect: NormalizedRect): NormalizedRect {
  const width = clamp(rect.width, 0.02, 1);
  const height = clamp(rect.height, 0.02, 1);
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  };
}

/**
 * One illustration, forced to fit a clip of `durationSec`. Shortening the
 * clip is handled by retimeRenderPlan; this is the other direction — an
 * edit in the panel that would push a boundary out of range.
 */
export function fitOverlay(overlay: Overlay, durationSec: number): Overlay {
  const duration = Math.max(MIN_OVERLAY_DURATION_SEC, durationSec);

  const startSec = clamp(overlay.startSec, 0, Math.max(0, duration - MIN_OVERLAY_DURATION_SEC - SPAN_MARGIN_SEC));
  const endSec = clamp(overlay.endSec, startSec + MIN_OVERLAY_DURATION_SEC + SPAN_MARGIN_SEC, duration);
  const span = endSec - startSec;

  return {
    ...overlay,
    startSec,
    endSec,
    rect: fitRect(overlay.rect),
    opacity: clamp(overlay.opacity, OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX),
    fadeSec: clamp(overlay.fadeSec, OVERLAY_FADE_SEC_MIN, Math.min(OVERLAY_FADE_SEC_MAX, span / 2)),
  };
}
