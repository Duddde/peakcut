import type { NormalizedRect } from "@/lib/domain/types";
import type { FrameTrack } from "./types";

export interface DeriveCropParams {
  targetAspect: number;
  sourceWidth: number;
  sourceHeight: number;
  atSec: number;
}

function interpolateCenter(track: FrameTrack, atSec: number): { cx: number; cy: number } {
  const keyframes = track.keyframes;
  if (keyframes.length === 0) {
    return { cx: 0.5, cy: 0.5 };
  }
  if (keyframes.length === 1 || atSec <= keyframes[0].tSec) {
    return { cx: keyframes[0].cx, cy: keyframes[0].cy };
  }
  const last = keyframes[keyframes.length - 1];
  if (atSec >= last.tSec) {
    return { cx: last.cx, cy: last.cy };
  }

  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1];
    const next = keyframes[i];
    if (atSec >= prev.tSec && atSec <= next.tSec) {
      const span = next.tSec - prev.tSec;
      const t = span === 0 ? 0 : (atSec - prev.tSec) / span;
      return {
        cx: prev.cx + (next.cx - prev.cx) * t,
        cy: prev.cy + (next.cy - prev.cy) * t,
      };
    }
  }

  return { cx: last.cx, cy: last.cy };
}

/**
 * Computes the normalized crop rectangle (relative to the source frame) at
 * a given time, following the tracked center and clamped to stay entirely
 * within the [0,1] frame bounds.
 */
export function deriveCropFromTrack(track: FrameTrack, params: DeriveCropParams): NormalizedRect {
  const { targetAspect, sourceWidth, sourceHeight, atSec } = params;
  const { cx, cy } = interpolateCenter(track, atSec);
  const sourceAspect = sourceWidth / sourceHeight;

  let width: number;
  let height: number;
  if (targetAspect <= sourceAspect) {
    height = 1;
    width = targetAspect / sourceAspect;
  } else {
    width = 1;
    height = sourceAspect / targetAspect;
  }

  const x = Math.min(Math.max(cx - width / 2, 0), 1 - width);
  const y = Math.min(Math.max(cy - height / 2, 0), 1 - height);

  return { x, y, width, height };
}
