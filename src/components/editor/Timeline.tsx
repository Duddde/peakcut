"use client";

import { useRef, useState } from "react";
import type { Segment } from "@/lib/domain/types";

/**
 * The clips, on the source's own time axis.
 *
 * Two things make this a timeline rather than a list. Clips sit where
 * they actually are in the video, so the gaps between them — the parts
 * nobody kept — are visible. And their edges can be dragged: trimming is
 * the edit people reach for first, and sending them to a number field to
 * do it is how an editor stops feeling like one.
 *
 * It owns no state beyond the drag in progress. Every change is handed
 * up as "this clip now runs from here to there", because moving a
 * boundary also re-slices the subtitles, rescores the clip and re-fits
 * its effects (see lib/analysis/retimeSegment) — none of which belongs
 * in a drawing component.
 */

/** Shortest clip the timeline will let a drag produce. */
export const MIN_CLIP_SEC = 1;

/** Seconds per keyboard nudge on a trim handle. */
export const NUDGE_SEC = 0.5;

export interface TimelineProps {
  segments: Segment[];
  totalDurationSec: number;
  selectedSegmentId: string;
  onSelect: (id: string) => void;
  readOnly?: boolean;
  /** New absolute bounds for a clip, after a drag or a nudge. */
  onRetime?: (segmentId: string, bounds: { startSec: number; endSec: number }) => void;
  /** Cut the clip in two at this absolute time. */
  onSplit?: (segmentId: string, atSec: number) => void;
  onDelete?: (segmentId: string) => void;
}

type DragEdge = "start" | "end";

interface DragState {
  segmentId: string;
  edge: DragEdge;
}

/** Where a pointer is, in seconds, clamped to the timeline. */
export function secondsAtPointer(
  clientX: number,
  rect: { left: number; width: number },
  totalDurationSec: number
): number {
  if (rect.width <= 0) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  return Math.min(totalDurationSec, Math.max(0, ratio * totalDurationSec));
}

/**
 * The bounds a drag produces: the dragged edge follows the pointer, the
 * other stays put, and the clip never collapses below MIN_CLIP_SEC —
 * dragging past the far edge stops there instead of inverting the clip.
 */
export function boundsAfterDrag(
  segment: Pick<Segment, "startSec" | "endSec">,
  edge: DragEdge,
  atSec: number,
  totalDurationSec: number
): { startSec: number; endSec: number } {
  if (edge === "start") {
    return { startSec: Math.max(0, Math.min(atSec, segment.endSec - MIN_CLIP_SEC)), endSec: segment.endSec };
  }
  return {
    startSec: segment.startSec,
    endSec: Math.min(totalDurationSec, Math.max(atSec, segment.startSec + MIN_CLIP_SEC)),
  };
}

function formatSec(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function Timeline({
  segments,
  totalDurationSec,
  selectedSegmentId,
  onSelect,
  readOnly = false,
  onRetime,
  onSplit,
  onDelete,
}: TimelineProps) {
  const total = totalDurationSec || 1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const editable = !readOnly && Boolean(onRetime);
  const selected = segments.find((s) => s.id === selectedSegmentId) ?? null;

  function pointerSeconds(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect ? secondsAtPointer(clientX, rect, total) : 0;
  }

  function applyDrag(state: DragState, clientX: number) {
    const segment = segments.find((s) => s.id === state.segmentId);
    if (!segment) return;
    onRetime?.(state.segmentId, boundsAfterDrag(segment, state.edge, pointerSeconds(clientX), total));
  }

  function nudge(segment: Segment, edge: DragEdge, deltaSec: number) {
    const atSec = (edge === "start" ? segment.startSec : segment.endSec) + deltaSec;
    onRetime?.(segment.id, boundsAfterDrag(segment, edge, atSec, total));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Timeline ({formatSec(total)})
        </h4>
        {editable && selected && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => onSplit?.(selected.id, (selected.startSec + selected.endSec) / 2)}
              disabled={!onSplit || selected.endSec - selected.startSec < 2 * MIN_CLIP_SEC}
              className="rounded border border-white/15 bg-white/5 px-2 py-1 text-zinc-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Couper en deux
            </button>
            <button
              type="button"
              onClick={() => onDelete?.(selected.id)}
              disabled={!onDelete}
              className="rounded border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-rose-300 transition hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Supprimer ce clip
            </button>
          </div>
        )}
      </div>

      <div
        ref={trackRef}
        role="listbox"
        aria-label="Segments sur la timeline"
        onPointerMove={(e) => {
          if (drag) applyDrag(drag, e.clientX);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        className="relative h-14 w-full overflow-hidden rounded-lg border border-white/10 bg-white/5"
      >
        {segments.map((segment) => {
          const leftPct = (segment.startSec / total) * 100;
          const widthPct = Math.max(0.5, ((segment.endSec - segment.startSec) / total) * 100);
          const isSelected = segment.id === selectedSegmentId;
          return (
            <div
              key={segment.id}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              className="absolute inset-y-0"
            >
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(segment.id)}
                title={`${segment.title} (${formatSec(segment.startSec)} – ${formatSec(segment.endSec)})`}
                className={`h-full w-full overflow-hidden rounded px-2 text-left text-[11px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                  isSelected ? "bg-amber-400 text-zinc-950" : "bg-white/10 text-zinc-300 hover:bg-white/20"
                }`}
              >
                <span className="block truncate">{segment.title}</span>
                <span className="block truncate opacity-70">
                  {formatSec(segment.startSec)} – {formatSec(segment.endSec)}
                </span>
              </button>

              {editable &&
                (["start", "end"] as const).map((edge) => (
                  <button
                    key={edge}
                    type="button"
                    aria-label={`${edge === "start" ? "Début" : "Fin"} du clip ${segment.title}`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setDrag({ segmentId: segment.id, edge });
                      onSelect(segment.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                      e.preventDefault();
                      nudge(segment, edge, e.key === "ArrowLeft" ? -NUDGE_SEC : NUDGE_SEC);
                    }}
                    className={`absolute inset-y-0 w-2 cursor-ew-resize rounded-sm bg-zinc-950/50 hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                      edge === "start" ? "left-0" : "right-0"
                    }`}
                  />
                ))}
            </div>
          );
        })}
      </div>

      {editable && (
        <p className="text-[11px] text-zinc-500">
          Glissez les bords d&apos;un clip pour le rogner (ou flèches ← → une fois la poignée
          sélectionnée). Rogner re-découpe les sous-titres, recalcule le score et réajuste les
          effets du clip.
        </p>
      )}
    </div>
  );
}
