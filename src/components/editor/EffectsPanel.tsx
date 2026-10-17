"use client";

import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { speakerChangeTimesWithin } from "@/lib/effects/defaultRenderPlanFor";
import {
  EFFECT_TEMPLATE_IDS,
  FONT_SIZE_SCALE_MAX,
  FONT_SIZE_SCALE_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  type EffectTemplateId,
  type RenderPlan,
} from "@/lib/effects/types";
import type { Segment } from "@/lib/domain/types";

/**
 * The clip's edit, as something the user changes rather than something
 * done to them.
 *
 * Every control here writes into the segment's own RenderPlan, which is
 * what the export compiles — so what this panel shows is what the file
 * will contain, not a preview of an intention. Values are clamped to the
 * same bounds the server re-checks on save (validateRenderPlan): the UI
 * cannot offer a setting the export would refuse.
 */

const TEMPLATE_LABELS: Record<EffectTemplateId, string> = {
  "subtle-punch": "Zoom lent (monologue)",
  "speaker-focus": "Punch sur changement de locuteur",
  "hook-emphasis": "Accroche appuyée",
  "clean-captions": "Sous-titres seuls, sans zoom",
};

const TEMPLATE_HINTS: Record<EffectTemplateId, string> = {
  "subtle-punch": "Une poussée progressive jusqu'au milieu du clip, puis retour au cadre initial.",
  "speaker-focus": "Un punch à chaque changement de locuteur détecté dans le transcript.",
  "hook-emphasis": "Zoom franc dès les premières secondes, sous-titres plus gros et colorés.",
  "clean-captions": "Aucun zoom : cadrage fixe et sous-titres discrets.",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The plan's zoom, re-scaled by `strength` in [0, 1]: 0 flattens every
 * keyframe to 1 (no zoom), 1 restores the template's own amplitude.
 * Scaling an amplitude down can never leave the bounds, so this control
 * cannot produce a plan the export refuses.
 */
export function withZoomStrength(plan: RenderPlan, strength: number): RenderPlan {
  const factor = clamp(strength, 0, 1);
  return {
    ...plan,
    zoomKeyframes: plan.zoomKeyframes.map((kf) => ({
      ...kf,
      scale: clamp(ZOOM_SCALE_MIN + (kf.scale - ZOOM_SCALE_MIN) * factor, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX),
    })),
  };
}

/** The strongest zoom in the plan, as a percentage above the base framing. */
export function peakZoomPercent(plan: RenderPlan): number {
  const peak = plan.zoomKeyframes.reduce((max, kf) => Math.max(max, kf.scale), ZOOM_SCALE_MIN);
  return Math.round((peak - 1) * 100);
}

export interface EffectsPanelProps {
  segment: Segment;
  readOnly?: boolean;
  onChange: (plan: RenderPlan) => void;
  onReadOnlyAttempt?: () => void;
}

export function EffectsPanel({ segment, readOnly = false, onChange, onReadOnlyAttempt }: EffectsPanelProps) {
  const plan = segment.renderPlan;
  const durationSec = Math.max(0, segment.endSec - segment.startSec);

  function guard(apply: () => void) {
    if (readOnly) {
      onReadOnlyAttempt?.();
      return;
    }
    apply();
  }

  function applyTemplate(templateId: EffectTemplateId) {
    guard(() =>
      onChange(
        buildRenderPlan(templateId, {
          segmentId: segment.id,
          segmentDurationSec: durationSec,
          speakerChangeTimesSec: speakerChangeTimesWithin(segment.words, segment.startSec),
        })
      )
    );
  }

  return (
    <section data-testid="effects-panel" className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">Effets du clip</h4>
        <p className="text-[11px] text-zinc-500">
          Ces réglages sont compilés tels quels dans l&apos;export : ce que vous voyez ici est ce que
          contiendra le fichier.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Modèle d&apos;effet
        <select
          aria-label="Modèle d'effet"
          value={plan?.templateId ?? ""}
          onChange={(e) => applyTemplate(e.target.value as EffectTemplateId)}
          className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
        >
          {!plan && <option value="">Aucun effet appliqué</option>}
          {EFFECT_TEMPLATE_IDS.map((id) => (
            <option key={id} value={id}>
              {TEMPLATE_LABELS[id]}
            </option>
          ))}
        </select>
      </label>

      {!plan ? (
        <p className="text-[11px] text-zinc-500">
          Ce clip n&apos;a pas encore d&apos;effets : il s&apos;exporte avec un cadrage fixe et des
          sous-titres standard. Choisissez un modèle pour en ajouter.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-zinc-500">{TEMPLATE_HINTS[plan.templateId]}</p>

          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            <span>
              Force du zoom — <span className="text-zinc-200">+{peakZoomPercent(plan)}%</span> au
              maximum
            </span>
            <input
              aria-label="Force du zoom"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(
                ((plan.zoomKeyframes.reduce((max, kf) => Math.max(max, kf.scale), 1) - 1) /
                  (ZOOM_SCALE_MAX - 1)) *
                  100
              )}
              onChange={(e) => {
                const target = Number(e.target.value) / 100;
                const template = buildRenderPlan(plan.templateId, {
                  segmentId: segment.id,
                  segmentDurationSec: durationSec,
                  speakerChangeTimesSec: speakerChangeTimesWithin(segment.words, segment.startSec),
                });
                const templatePeak = template.zoomKeyframes.reduce((max, kf) => Math.max(max, kf.scale), 1);
                // Expressed against the full range, then converted into a
                // fraction of this template's own amplitude.
                const amplitude = templatePeak - 1;
                const strength = amplitude > 0 ? (target * (ZOOM_SCALE_MAX - 1)) / amplitude : 0;
                guard(() => onChange({ ...withZoomStrength(template, strength), subtitleStyle: plan.subtitleStyle }));
              }}
              className="accent-amber-400"
            />
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Couleur des sous-titres
              <input
                aria-label="Couleur des sous-titres"
                type="color"
                value={plan.subtitleStyle.primaryColorHex}
                onChange={(e) =>
                  guard(() =>
                    onChange({
                      ...plan,
                      subtitleStyle: { ...plan.subtitleStyle, primaryColorHex: e.target.value.toUpperCase() },
                    })
                  )
                }
                className="h-8 w-14 rounded border border-white/10 bg-zinc-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Taille des sous-titres ({plan.subtitleStyle.fontSizeScale.toFixed(2)}×)
              <input
                aria-label="Taille des sous-titres"
                type="range"
                min={FONT_SIZE_SCALE_MIN}
                max={FONT_SIZE_SCALE_MAX}
                step={0.05}
                value={plan.subtitleStyle.fontSizeScale}
                onChange={(e) =>
                  guard(() =>
                    onChange({
                      ...plan,
                      subtitleStyle: {
                        ...plan.subtitleStyle,
                        fontSizeScale: clamp(Number(e.target.value), FONT_SIZE_SCALE_MIN, FONT_SIZE_SCALE_MAX),
                      },
                    })
                  )
                }
                className="accent-amber-400"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={plan.subtitleStyle.emphasizeKeywords}
                onChange={(e) =>
                  guard(() =>
                    onChange({
                      ...plan,
                      subtitleStyle: { ...plan.subtitleStyle, emphasizeKeywords: e.target.checked },
                    })
                  )
                }
                className="accent-amber-400"
              />
              Mettre les mots-clés en avant
            </label>
          </div>

          <details className="text-[11px] text-zinc-500">
            <summary className="cursor-pointer text-zinc-400">
              {plan.zoomKeyframes.length} image(s) clé de zoom · ce que l&apos;export n&apos;applique pas
            </summary>
            <ul className="mt-1 space-y-0.5">
              {plan.zoomKeyframes.map((kf, index) => (
                <li key={`${kf.tSec}-${index}`}>
                  t = {kf.tSec.toFixed(1)}s → {Math.round((kf.scale - 1) * 100)}%
                </li>
              ))}
            </ul>
            <ul className="mt-2 space-y-0.5">
              {plan.limitations.map((limitation) => (
                <li key={limitation}>· {limitation}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
