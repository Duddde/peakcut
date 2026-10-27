"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment, TranscriptWord } from "@/lib/domain/types";
import { MIN_CLIP_SEC } from "./Timeline";

/**
 * Where exactly a clip starts and ends, decided against what is said and
 * heard there.
 *
 * The project timeline shows the whole video: on half an hour, a pixel is
 * two seconds, and a cut cannot be put between two words. This shows each
 * edge of the selected clip on its own, ten seconds wide, with the words
 * at their place and the audio level under them — the pause where a cut
 * belongs is a visible dip. Dragging snaps to the nearest word boundary
 * (hold Alt to place it freely), and the buttons step word by word.
 */

export type ClipEdge = "start" | "end";

/** Seconds shown around an edge. */
export const EDGE_VIEW_SEC = 10;
/** The view moves in steps of this many seconds. */
const VIEW_STEP_SEC = 2.5;
/** A drop this close to a word boundary lands on it. */
const SNAP_SEC = 0.25;
const WAVEFORM_POINTS = 400;
const FINE_STEP_SEC = 0.1;

const SPEAKER_COLORS = ["text-sky-300", "text-amber-200", "text-emerald-300", "text-rose-300", "text-violet-300"];

function formatTime(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

/**
 * Where a cut may land around `atSec`: word starts for a clip's start,
 * word ends for its end — a start on a word's end would open on silence
 * and drop that word, an end on a word's start would cut it off.
 */
export function wordBoundaries(words: TranscriptWord[], edge: ClipEdge): number[] {
  return [...new Set(words.map((word) => (edge === "start" ? word.startSec : word.endSec)))].sort((a, b) => a - b);
}

/** The boundary nearest `atSec` if it is within the snap distance, else `atSec` itself. */
export function snapToBoundary(atSec: number, boundaries: number[]): number {
  let best = atSec;
  let bestDistance = SNAP_SEC;
  for (const boundary of boundaries) {
    const distance = Math.abs(boundary - atSec);
    if (distance <= bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }
  return best;
}

/** The next boundary strictly after (direction 1) or before (-1) `atSec`. */
export function stepBoundary(atSec: number, boundaries: number[], direction: 1 | -1): number | null {
  const candidates = direction === 1 ? boundaries.filter((b) => b > atSec + 1e-3) : boundaries.filter((b) => b < atSec - 1e-3);
  if (candidates.length === 0) return null;
  return direction === 1 ? candidates[0] : candidates[candidates.length - 1];
}

interface Waveform {
  startSec: number;
  frameSec: number;
  levels: number[];
}

function useWaveform(projectId: string | undefined, fromSec: number, toSec: number): Waveform | null {
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  useEffect(() => {
    if (!projectId || !(toSec > fromSec)) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      startSec: fromSec.toFixed(3),
      endSec: toSec.toFixed(3),
      points: String(WAVEFORM_POINTS),
    });
    fetch(`/api/projects/${projectId}/waveform?${query}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (json?.ok && Array.isArray(json.levels)) {
          setWaveform({ startSec: json.startSec, frameSec: json.frameSec, levels: json.levels });
        }
      })
      // Without the waveform the words are still there to cut against.
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId, fromSec, toSec]);
  return waveform;
}

function EdgeEditor({
  edge,
  segment,
  words,
  totalDurationSec,
  projectId,
  readOnly,
  onMove,
}: {
  edge: ClipEdge;
  segment: Segment;
  words: TranscriptWord[];
  totalDurationSec: number;
  projectId?: string;
  readOnly: boolean;
  onMove: (atSec: number) => void;
}) {
  const atSec = edge === "start" ? segment.startSec : segment.endSec;
  const minSec = edge === "start" ? 0 : segment.startSec + MIN_CLIP_SEC;
  const maxSec = edge === "start" ? segment.endSec - MIN_CLIP_SEC : totalDurationSec;

  // The view moves by whole steps rather than following the edge: the
  // picture does not slide under the pointer at every move, and the
  // waveform is only fetched again when the view really changes.
  const gridFrom = Math.floor((atSec - EDGE_VIEW_SEC / 2) / VIEW_STEP_SEC) * VIEW_STEP_SEC;
  const viewFrom = Math.max(0, Math.min(gridFrom, totalDurationSec - EDGE_VIEW_SEC));
  const viewTo = Math.min(totalDurationSec, viewFrom + EDGE_VIEW_SEC);
  const span = Math.max(viewTo - viewFrom, 1e-6);

  const waveform = useWaveform(projectId, viewFrom, viewTo);
  const boundaries = useMemo(() => wordBoundaries(words, edge), [words, edge]);
  const visibleWords = words.filter((word) => word.endSec > viewFrom && word.startSec < viewTo);
  const speakers = useMemo(() => [...new Set(words.map((word) => word.speaker ?? ""))], [words]);

  const areaRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (sec: number) => Math.min(maxSec, Math.max(minSec, sec));
  const pct = (sec: number) => ((sec - viewFrom) / span) * 100;

  function secondsAt(clientX: number, free: boolean): number {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return atSec;
    const raw = viewFrom + ((clientX - rect.left) / rect.width) * span;
    return clamp(free ? raw : snapToBoundary(raw, boundaries));
  }

  function step(direction: 1 | -1) {
    const next = stepBoundary(atSec, boundaries, direction);
    if (next !== null) onMove(clamp(next));
  }

  // By word starts on both sides: the clip holds every word that starts
  // inside it, and a word's estimated end can fall a little after a cut
  // that the audio placed right after it.
  const wordAtCut =
    edge === "start"
      ? words.find((word) => word.startSec >= atSec - 1e-3)
      : [...words].reverse().find((word) => word.startSec < atSec);
  const label = edge === "start" ? "Début du clip" : "Fin du clip";

  return (
    <div className="min-w-0 flex-1 space-y-2 rounded-xl border border-white/10 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-zinc-200">
          {label} <span className="font-mono text-amber-300">{formatTime(atSec)}</span>
        </h4>
        {wordAtCut && (
          <p className="truncate text-[11px] text-zinc-500">
            {edge === "start" ? "commence sur" : "finit sur"} « {wordAtCut.text} »
          </p>
        )}
      </div>

      <div
        ref={areaRef}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={label}
        aria-valuemin={Number(minSec.toFixed(2))}
        aria-valuemax={Number(maxSec.toFixed(2))}
        aria-valuenow={Number(atSec.toFixed(2))}
        aria-valuetext={formatTime(atSec)}
        onPointerDown={(e) => {
          if (readOnly) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDragging(true);
          onMove(secondsAt(e.clientX, e.altKey));
        }}
        onPointerMove={(e) => {
          if (dragging) onMove(secondsAt(e.clientX, e.altKey));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const direction = e.key === "ArrowRight" ? 1 : -1;
            if (e.shiftKey) onMove(clamp(atSec + direction * FINE_STEP_SEC));
            else step(direction);
          }
        }}
        className={`relative h-24 select-none overflow-hidden rounded-lg bg-white/[0.03] outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
          readOnly ? "" : "cursor-ew-resize"
        }`}
      >
        {/* The part of the view that is inside the clip. */}
        <div
          className="absolute inset-y-0 bg-amber-400/10"
          style={
            edge === "start"
              ? { left: `${Math.max(0, pct(atSec))}%`, right: 0 }
              : { left: 0, width: `${Math.min(100, Math.max(0, pct(atSec)))}%` }
          }
        />

        {waveform && (
          <svg
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-14 w-full text-zinc-500"
            viewBox={`0 0 ${waveform.levels.length} 100`}
            preserveAspectRatio="none"
          >
            {waveform.levels.map((level, i) => {
              const height = Math.max(1, level * 100);
              return <rect key={i} x={i} y={(100 - height) / 2} width={0.8} height={height} fill="currentColor" />;
            })}
          </svg>
        )}

        {visibleWords.map((word, i) => {
          const speakerIndex = speakers.indexOf(word.speaker ?? "");
          return (
            <span
              key={`${word.startSec}-${i}`}
              title={`${word.text} (${formatTime(word.startSec)})`}
              className={`pointer-events-none absolute top-1 whitespace-nowrap text-[10px] ${
                SPEAKER_COLORS[speakerIndex % SPEAKER_COLORS.length]
              }`}
              style={{ left: `${pct(word.startSec)}%`, top: `${4 + (i % 3) * 12}px` }}
            >
              {word.text}
            </span>
          );
        })}

        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${pct(atSec)}%` }} />
      </div>

      {!readOnly && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <button type="button" onClick={() => step(-1)} className="rounded border border-white/15 px-2 py-1 text-zinc-200 hover:bg-white/10">
            ← mot
          </button>
          <button
            type="button"
            onClick={() => onMove(clamp(atSec - FINE_STEP_SEC))}
            className="rounded border border-white/15 px-2 py-1 text-zinc-200 hover:bg-white/10"
          >
            −0,1 s
          </button>
          <button
            type="button"
            onClick={() => onMove(clamp(atSec + FINE_STEP_SEC))}
            className="rounded border border-white/15 px-2 py-1 text-zinc-200 hover:bg-white/10"
          >
            +0,1 s
          </button>
          <button type="button" onClick={() => step(1)} className="rounded border border-white/15 px-2 py-1 text-zinc-200 hover:bg-white/10">
            mot →
          </button>
        </div>
      )}
    </div>
  );
}

export function ClipTrimmer({
  segment,
  words,
  totalDurationSec,
  projectId,
  readOnly = false,
  onRetime,
}: {
  segment: Segment;
  /** The whole transcript, so an edge can move onto words outside the clip. */
  words: TranscriptWord[];
  totalDurationSec: number;
  projectId?: string;
  readOnly?: boolean;
  onRetime: (segmentId: string, bounds: { startSec: number; endSec: number }) => void;
}) {
  return (
    <section data-testid="clip-trimmer" className="space-y-2 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Cuts du clip</h3>
        <p className="text-[11px] text-zinc-500">
          Glissez la ligne pour déplacer le cut : elle s&apos;aimante au mot le plus proche (Alt pour la placer
          librement). Les creux de l&apos;onde sont les pauses, là où un cut ne coupe personne. Flèches : mot par mot ;
          Maj + flèches : 0,1 s. L&apos;aperçu se met à jour tout seul.
        </p>
      </div>
      <div className="flex flex-col gap-3 md:flex-row">
        {(["start", "end"] as const).map((edge) => (
          <EdgeEditor
            key={`${segment.id}-${edge}`}
            edge={edge}
            segment={segment}
            words={words}
            totalDurationSec={totalDurationSec}
            projectId={projectId}
            readOnly={readOnly}
            onMove={(atSec) =>
              onRetime(
                segment.id,
                edge === "start" ? { startSec: atSec, endSec: segment.endSec } : { startSec: segment.startSec, endSec: atSec }
              )
            }
          />
        ))}
      </div>
    </section>
  );
}
