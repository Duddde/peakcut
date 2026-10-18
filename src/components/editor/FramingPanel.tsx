"use client";

import {
  framingSubjects,
  moveFramingBoundary,
  removeFramingShot,
  retargetFramingShot,
  setFramingTransition,
} from "@/lib/effects/framingEdits";
import { FRAMING_TRANSITION_SEC_MAX, type RenderPlan } from "@/lib/effects/types";
import type { Segment } from "@/lib/domain/types";

/**
 * The clip's framing, shot by shot: who the frame is on, and from when.
 *
 * The shots themselves come from the tracking job, which is the only
 * layer that has looked at the video — matching each diarized voice to
 * the face whose mouth moved while it spoke. This panel is what makes
 * that editable rather than imposed: move a cut, send a shot to the other
 * person, turn a cut into a pan, or drop the whole thing and go back to
 * one fixed frame.
 *
 * Every control goes through lib/effects/framingEdits, which keeps the
 * shots contiguous and inside the bounds the server re-checks on save —
 * so this panel cannot offer a framing the export would refuse.
 */

const SOURCE_LABELS: Record<RenderPlan["framing"][number]["source"], string> = {
  speaker: "locuteur détecté",
  subject: "sujet détecté",
  manual: "votre choix",
};

export interface FramingPanelProps {
  segment: Segment;
  readOnly?: boolean;
  onChange: (plan: RenderPlan) => void;
  onReadOnlyAttempt?: () => void;
}

export function FramingPanel({ segment, readOnly = false, onChange, onReadOnlyAttempt }: FramingPanelProps) {
  const plan = segment.renderPlan;
  const shots = plan?.framing ?? [];
  const subjects = framingSubjects(shots);

  function guard(apply: () => void) {
    if (readOnly) {
      onReadOnlyAttempt?.();
      return;
    }
    apply();
  }

  function applyShots(framing: RenderPlan["framing"]) {
    if (!plan) return;
    guard(() => onChange({ ...plan, framing }));
  }

  if (!plan) {
    return (
      <section data-testid="framing-panel" className="space-y-2">
        <h4 className="text-sm font-semibold text-zinc-100">Cadrage du clip</h4>
        <p className="text-[11px] text-zinc-500">
          Ce clip n&apos;a pas encore de plan de montage : son cadrage est celui de la variante
          choisie, fixe du début à la fin.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="framing-panel" className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">Cadrage du clip</h4>
        <p className="text-[11px] text-zinc-500">
          Le cadre suit la personne qui parle : un plan par prise de parole, recadré sur son visage.
          Ces coupes sont compilées telles quelles dans l&apos;export et dans l&apos;aperçu.
        </p>
      </div>

      {shots.length === 0 ? (
        <p data-testid="framing-empty" className="text-[11px] text-zinc-500">
          Aucun plan de cadrage sur ce clip : le cadre reste fixe. Pour qu&apos;il suive le locuteur,
          il faut une transcription qui distingue les intervenants et un job de suivi qui mesure
          l&apos;activité labiale — le résultat du job de suivi dit précisément ce qui manque. Un
          clip où une seule personne parle n&apos;en a pas besoin : le cadrage la suit déjà.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-zinc-500">
            {shots.length} plan(s) · {subjects.length} intervenant(s) cadré(s)
          </p>

          <ul className="space-y-3">
            {shots.map((shot, index) => {
              const duration = shot.endSec - shot.startSec;
              const isLast = index === shots.length - 1;
              return (
                <li
                  key={shot.id}
                  data-testid={`framing-shot-${shot.id}`}
                  className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-200">
                      {shot.label ?? "Sujet sans nom"}{" "}
                      <span className="text-[10px] text-zinc-500">({SOURCE_LABELS[shot.source]})</span>
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {shot.startSec.toFixed(1)}s → {shot.endSec.toFixed(1)}s · {duration.toFixed(1)}s
                    </span>
                  </div>

                  {subjects.length > 1 && (
                    <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                      Cadrer ce plan sur
                      <select
                        aria-label={`Cadrer le plan ${index + 1} sur`}
                        value={shot.label ?? "Sujet sans nom"}
                        onChange={(e) => {
                          const subject = subjects.find((s) => s.label === e.target.value);
                          if (subject) applyShots(retargetFramingShot(shots, shot.id, subject));
                        }}
                        className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
                      >
                        {subjects.map((subject) => (
                          <option key={subject.label} value={subject.label}>
                            {subject.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {!isLast && (
                    <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                      Coupe vers le plan suivant ({shot.endSec.toFixed(1)}s)
                      <input
                        aria-label={`Coupe après le plan ${index + 1}`}
                        type="range"
                        min={0}
                        max={Math.max(0, segment.endSec - segment.startSec)}
                        step={0.1}
                        value={shot.endSec}
                        onChange={(e) => applyShots(moveFramingBoundary(shots, index, Number(e.target.value)))}
                        className="accent-amber-400"
                      />
                    </label>
                  )}

                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    {shot.transitionSec > 0
                      ? `Panoramique d'entrée (${shot.transitionSec.toFixed(2)}s)`
                      : "Panoramique d'entrée (coupe franche)"}
                    <input
                      aria-label={`Panoramique du plan ${index + 1}`}
                      type="range"
                      min={0}
                      max={FRAMING_TRANSITION_SEC_MAX}
                      step={0.05}
                      value={shot.transitionSec}
                      onChange={(e) => applyShots(setFramingTransition(shots, shot.id, Number(e.target.value)))}
                      className="accent-amber-400"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => applyShots(removeFramingShot(shots, shot.id))}
                    className="text-[11px] text-zinc-500 underline hover:text-zinc-300"
                  >
                    Supprimer ce plan
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => applyShots([])}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:border-white/30"
          >
            Revenir à un cadre fixe
          </button>
        </>
      )}
    </section>
  );
}
