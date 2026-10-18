"use client";

import {
  addPerspectiveMove,
  movePerspectiveMoveTo,
  nextPerspectiveMoveId,
  removePerspectiveMove,
  setPerspectiveAmount,
  setPerspectiveDirection,
  setPerspectiveDuration,
  setPerspectiveProfile,
} from "@/lib/effects/perspectiveEdits";
import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  PERSPECTIVE_AMOUNT_MAX,
  PERSPECTIVE_AMOUNT_MIN,
  PERSPECTIVE_DIRECTIONS,
  PERSPECTIVE_PROFILES,
  type PerspectiveDirection,
  type PerspectiveProfile,
  type RenderPlan,
} from "@/lib/effects/types";
import type { Segment } from "@/lib/domain/types";

/**
 * The clip's 3D moves: when the frame tilts in space, which way, and how.
 *
 * What the effect actually is matters for what this panel can honestly
 * offer. The frame is treated as a flat plane and projected from a camera
 * that turns — a real perspective transform, applied by ffmpeg to the
 * finished frame. So there is no depth in the image to play with: a face
 * does not detach from its background, and no control here pretends it
 * does. What a move gives is a camera that moves, which is what makes a
 * static talking head feel shot rather than cropped.
 *
 * Every control goes through lib/effects/perspectiveEdits, which keeps
 * the moves inside the clip, long enough to be seen, and never two on the
 * same axis at once — so this panel cannot offer a plan the export would
 * refuse.
 */

const DIRECTION_LABELS: Record<PerspectiveDirection, string> = {
  left: "le bord gauche s'avance",
  right: "le bord droit s'avance",
  up: "le bord haut s'avance",
  down: "le bord bas s'avance",
};

const PROFILE_LABELS: Record<PerspectiveProfile, string> = {
  swing: "balancement (part et revient à plat)",
  settle: "atterrissage (arrive incliné, se pose)",
  lift: "envol (part à plat, s'incline)",
};

export interface PerspectivePanelProps {
  segment: Segment;
  readOnly?: boolean;
  onChange: (plan: RenderPlan) => void;
  onReadOnlyAttempt?: () => void;
}

interface Preset {
  key: string;
  label: string;
  hint: string;
  build: (durationSec: number) => {
    startSec: number;
    endSec: number;
    direction: PerspectiveDirection;
    profile: PerspectiveProfile;
    amount: number;
  };
}

/**
 * The three moves worth one click, because each belongs to a precise
 * moment: a clip opens, a clip breathes in the middle, a clip ends.
 * Anything else is a matter of taste and belongs to the controls below.
 */
const PRESETS: Preset[] = [
  {
    key: "settle",
    label: "Atterrissage au début",
    hint: "l'image arrive inclinée et se pose : l'ouverture d'un hook",
    build: () => ({ startSec: 0, endSec: 0.6, direction: "left", profile: "settle", amount: 0.8 }),
  },
  {
    key: "swing",
    label: "Balancement au milieu",
    hint: "un mouvement de caméra qui part et revient, sans coupe",
    build: (durationSec) => ({
      startSec: Math.max(0, durationSec / 2 - 0.6),
      endSec: Math.max(0, durationSec / 2 - 0.6) + 1.2,
      direction: "right",
      profile: "swing",
      amount: 0.5,
    }),
  },
  {
    key: "lift",
    label: "Envol à la fin",
    hint: "l'image s'incline en quittant l'écran",
    build: (durationSec) => ({
      startSec: Math.max(0, durationSec - 0.8),
      endSec: durationSec,
      direction: "up",
      profile: "lift",
      amount: 0.7,
    }),
  },
];

export function PerspectivePanel({
  segment,
  readOnly = false,
  onChange,
  onReadOnlyAttempt,
}: PerspectivePanelProps) {
  const plan = segment.renderPlan;
  const moves = plan?.perspectiveMoves ?? [];
  const clipDurationSec = Math.max(0, segment.endSec - segment.startSec);

  function applyMoves(perspectiveMoves: RenderPlan["perspectiveMoves"]) {
    if (!plan) return;
    if (readOnly) {
      onReadOnlyAttempt?.();
      return;
    }
    onChange({ ...plan, perspectiveMoves });
  }

  if (!plan) {
    return (
      <section data-testid="perspective-panel" className="space-y-2">
        <h4 className="text-sm font-semibold text-zinc-100">Effets 3D</h4>
        <p className="text-[11px] text-zinc-500">
          Ce clip n&apos;a pas encore de plan de montage : son image reste plate du début à la fin.
        </p>
      </section>
    );
  }

  const atCap = moves.length >= MAX_PERSPECTIVE_MOVES_PER_PLAN;

  return (
    <section data-testid="perspective-panel" className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">Effets 3D</h4>
        <p className="text-[11px] text-zinc-500">
          L&apos;image est traitée comme un plan incliné dans l&apos;espace, puis reprojetée : la
          caméra tourne autour du clip. C&apos;est une vraie transformation de perspective, compilée
          dans l&apos;export et dans l&apos;aperçu — pas une déformation 2D qui en imiterait
          l&apos;effet. En revanche il n&apos;y a pas de profondeur dans l&apos;image : le visage ne
          se détache pas du décor.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={atCap}
            title={preset.hint}
            onClick={() => {
              const built = preset.build(clipDurationSec);
              applyMoves(
                addPerspectiveMove(
                  moves,
                  { id: nextPerspectiveMoveId(moves), ...built },
                  clipDurationSec
                )
              );
            }}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {atCap && (
        <p data-testid="perspective-cap" className="text-[11px] text-amber-300/80">
          Maximum atteint : {MAX_PERSPECTIVE_MOVES_PER_PLAN} mouvements par clip. Au-delà, le filtre
          devient trop long pour être rendu.
        </p>
      )}

      {moves.length === 0 ? (
        <p data-testid="perspective-empty" className="text-[11px] text-zinc-500">
          Aucun effet 3D sur ce clip : l&apos;image reste plate. Les modèles n&apos;en ajoutent pas
          d&apos;eux-mêmes, sauf « hook-emphasis » qui pose son ouverture — une inclinaison sur
          chaque clip se verrait comme un filtre appliqué au lot, pas comme un montage.
        </p>
      ) : (
        <ul className="space-y-3">
          {moves.map((move, index) => (
            <li
              key={move.id}
              data-testid={`perspective-move-${move.id}`}
              className="space-y-2 rounded-xl border border-white/10 bg-zinc-950/40 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-200">Mouvement {index + 1}</span>
                <span className="text-[10px] text-zinc-500">
                  {move.startSec.toFixed(1)}s → {move.endSec.toFixed(1)}s
                </span>
              </div>

              <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                Sens
                <select
                  aria-label={`Sens du mouvement ${index + 1}`}
                  value={move.direction}
                  onChange={(e) =>
                    applyMoves(
                      setPerspectiveDirection(moves, move.id, e.target.value as PerspectiveDirection)
                    )
                  }
                  className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
                >
                  {PERSPECTIVE_DIRECTIONS.map((direction) => (
                    <option key={direction} value={direction}>
                      {DIRECTION_LABELS[direction]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                Mouvement
                <select
                  aria-label={`Profil du mouvement ${index + 1}`}
                  value={move.profile}
                  onChange={(e) =>
                    applyMoves(
                      setPerspectiveProfile(moves, move.id, e.target.value as PerspectiveProfile)
                    )
                  }
                  className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-amber-400/60"
                >
                  {PERSPECTIVE_PROFILES.map((profile) => (
                    <option key={profile} value={profile}>
                      {PROFILE_LABELS[profile]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                Intensité ({Math.round(move.amount * 100)}%)
                <input
                  aria-label={`Intensité du mouvement ${index + 1}`}
                  type="range"
                  min={PERSPECTIVE_AMOUNT_MIN}
                  max={PERSPECTIVE_AMOUNT_MAX}
                  step={0.05}
                  value={move.amount}
                  onChange={(e) =>
                    applyMoves(setPerspectiveAmount(moves, move.id, Number(e.target.value)))
                  }
                  className="accent-amber-400"
                />
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                Début ({move.startSec.toFixed(1)}s)
                <input
                  aria-label={`Début du mouvement ${index + 1}`}
                  type="range"
                  min={0}
                  max={clipDurationSec}
                  step={0.1}
                  value={move.startSec}
                  onChange={(e) =>
                    applyMoves(
                      movePerspectiveMoveTo(moves, move.id, Number(e.target.value), clipDurationSec)
                    )
                  }
                  className="accent-amber-400"
                />
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                Durée ({(move.endSec - move.startSec).toFixed(1)}s)
                <input
                  aria-label={`Durée du mouvement ${index + 1}`}
                  type="range"
                  min={MIN_PERSPECTIVE_MOVE_DURATION_SEC}
                  max={Math.max(MIN_PERSPECTIVE_MOVE_DURATION_SEC, clipDurationSec)}
                  step={0.1}
                  value={move.endSec - move.startSec}
                  onChange={(e) =>
                    applyMoves(
                      setPerspectiveDuration(moves, move.id, Number(e.target.value), clipDurationSec)
                    )
                  }
                  className="accent-amber-400"
                />
              </label>

              <button
                type="button"
                onClick={() => applyMoves(removePerspectiveMove(moves, move.id))}
                className="text-[11px] text-zinc-500 underline hover:text-zinc-300"
              >
                Supprimer ce mouvement
              </button>
            </li>
          ))}
        </ul>
      )}

      {moves.length > 0 && (
        <button
          type="button"
          onClick={() => applyMoves([])}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:border-white/30"
        >
          Revenir à une image plate
        </button>
      )}
    </section>
  );
}
