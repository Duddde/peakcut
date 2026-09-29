"use client";

import { useMemo, useState } from "react";
import type { Project, Segment } from "@/lib/domain/types";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { ScoreExplanation } from "./ScoreExplanation";
import { Timeline } from "./Timeline";
import { TranscriptEditor } from "./TranscriptEditor";
import { VariantPicker } from "./VariantPicker";

function rescoreSegment(segment: Segment): Segment {
  return {
    ...segment,
    score: scoreSegment({
      words: segment.words,
      startSec: segment.startSec,
      endSec: segment.endSec,
    }),
  };
}

export function EditorDemo({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState<Project>(initialProject);
  const [selectedSegmentId, setSelectedSegmentId] = useState(initialProject.segments[0]?.id ?? "");
  const [selectedVariantBysegment, setSelectedVariantBysegment] = useState<Record<string, string>>(
    () => Object.fromEntries(initialProject.segments.map((s) => [s.id, s.variants[0]?.id ?? ""]))
  );

  const selectedSegment = useMemo(
    () => project.segments.find((s) => s.id === selectedSegmentId) ?? project.segments[0],
    [project, selectedSegmentId]
  );

  function updateSegment(id: string, updater: (segment: Segment) => Segment) {
    setProject((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => (s.id === id ? rescoreSegment(updater(s)) : s)),
    }));
  }

  if (!selectedSegment) return null;
  const selectedVariantId = selectedVariantBysegment[selectedSegment.id] ?? selectedSegment.variants[0]?.id;

  return (
    <div className="space-y-6">
      <Timeline
        segments={project.segments}
        totalDurationSec={project.timeline?.totalDurationSec ?? 0}
        selectedSegmentId={selectedSegmentId}
        onSelect={setSelectedSegmentId}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <label className="sr-only" htmlFor="segment-title">
                Titre du segment
              </label>
              <input
                id="segment-title"
                type="text"
                value={selectedSegment.title}
                onChange={(e) =>
                  updateSegment(selectedSegment.id, (s) => ({ ...s, title: e.target.value }))
                }
                className="w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-base font-semibold text-zinc-100 outline-none focus:border-amber-400/60"
              />
              <div className="mt-2 flex gap-3 text-xs text-zinc-500">
                <label className="flex items-center gap-1">
                  Début (s)
                  <input
                    type="number"
                    step={0.1}
                    value={selectedSegment.startSec}
                    onChange={(e) =>
                      updateSegment(selectedSegment.id, (s) => ({
                        ...s,
                        startSec: Number(e.target.value),
                      }))
                    }
                    className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Fin (s)
                  <input
                    type="number"
                    step={0.1}
                    value={selectedSegment.endSec}
                    onChange={(e) =>
                      updateSegment(selectedSegment.id, (s) => ({
                        ...s,
                        endSec: Number(e.target.value),
                      }))
                    }
                    className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                  />
                </label>
              </div>
            </div>
          </div>

          {selectedSegment.score && <ScoreExplanation score={selectedSegment.score} />}
        </div>

        <div className="space-y-6 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <TranscriptEditor
            words={selectedSegment.words}
            onChangeWord={(index, patch) =>
              updateSegment(selectedSegment.id, (s) => ({
                ...s,
                words: s.words.map((w, i) => (i === index ? { ...w, ...patch } : w)),
              }))
            }
          />
          <VariantPicker
            variants={selectedSegment.variants}
            selectedVariantId={selectedVariantId}
            onSelect={(id) =>
              setSelectedVariantBysegment((prev) => ({ ...prev, [selectedSegment.id]: id }))
            }
            onChangeCrop={(variantId, patch) =>
              updateSegment(selectedSegment.id, (s) => ({
                ...s,
                variants: s.variants.map((v) =>
                  v.id === variantId ? { ...v, crop: { ...v.crop, ...patch } } : v
                ),
              }))
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
        Mode validation humaine actif : ce projet reste à l&apos;état « {project.status} » tant
        qu&apos;aucune personne n&apos;a explicitement approuvé les segments. PeakCut ne publie rien
        automatiquement.
      </div>
    </div>
  );
}
