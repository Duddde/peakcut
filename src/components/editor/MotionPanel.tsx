"use client";

import { useState } from "react";
import type { Segment } from "@/lib/domain/types";
import type { RenderPlan } from "@/lib/effects/types";
import {
  MAX_MOTION_CARD_SEC,
  MAX_MOTION_CARDS_PER_PLAN,
  MIN_MOTION_CARD_SEC,
  MOTION_DETAIL_MAX_LENGTH,
  MOTION_ITEM_MAX_LENGTH,
  MOTION_LIST_MAX_ITEMS,
  MOTION_TEXT_MAX_LENGTH,
  validateMotionCards,
  type MotionCard,
  type MotionCardKind,
} from "@/lib/motion/types";

/**
 * Claude Motion in the studio: the animated cards of the selected clip,
 * which Claude designs from what is said and the editor then adjusts —
 * wording, timing, kind, place — or removes.
 *
 * Every edit is kept inside the bounds the export checks: a card the
 * validator refused would make the whole plan refused, framing and zoom
 * included, so the panel never produces one, and says so if a card is
 * still off (after a clip was shortened, for instance).
 */

const KIND_LABELS: Record<MotionCardKind, string> = {
  keyword: "Idée clé",
  stat: "Chiffre",
  list: "Liste",
  quote: "Citation",
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function MotionPanel({
  segment,
  configured,
  readOnly = false,
  generating,
  message,
  onGenerate,
  onChange,
}: {
  segment: Segment;
  /** Whether a Claude credential is configured on the server. */
  configured: boolean;
  readOnly?: boolean;
  generating: boolean;
  message: string | null;
  onGenerate: () => void;
  onChange: (renderPlan: RenderPlan) => void;
}) {
  const plan = segment.renderPlan;
  const cards = plan?.motion ?? [];
  const clipDurationSec = segment.endSec - segment.startSec;
  const errors = plan ? validateMotionCards(cards, clipDurationSec) : [];
  const [openId, setOpenId] = useState<string | null>(null);

  function setCards(next: MotionCard[]) {
    if (!plan) return;
    onChange({ ...plan, motion: next });
  }

  function update(id: string, patch: Partial<MotionCard>) {
    setCards(
      cards.map((card) => {
        if (card.id !== id) return card;
        const merged = { ...card, ...patch };
        // Timing stays readable and inside the clip whatever is typed.
        const startSec = Math.min(Math.max(0, merged.startSec), Math.max(0, clipDurationSec - MIN_MOTION_CARD_SEC));
        const endSec = Math.min(
          clipDurationSec,
          Math.max(startSec + MIN_MOTION_CARD_SEC, Math.min(merged.endSec, startSec + MAX_MOTION_CARD_SEC))
        );
        return {
          ...merged,
          startSec: round1(startSec),
          endSec: round1(endSec),
          items: merged.kind === "list" ? merged.items : [],
        };
      })
    );
  }

  return (
    <div data-testid="motion-panel" className="space-y-3 rounded-xl border border-white/10 bg-zinc-950/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-zinc-100">Claude Motion</h4>
          <p className="text-[11px] text-zinc-500">
            Des cartes animées qui illustrent le propos au moment où il est dit : idée clé, chiffre, liste, citation.
            Claude les conçoit à partir de la transcription ; elles sont incrustées par l&apos;export et par l&apos;aperçu.
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!configured || generating || !plan}
            className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? "Claude travaille…" : cards.length > 0 ? "Régénérer avec Claude" : "Générer avec Claude"}
          </button>
        )}
      </div>

      {!configured && (
        <p className="text-[11px] text-zinc-500">
          Claude Motion n&apos;est pas configuré sur ce serveur : ajoutez <code>ANTHROPIC_API_KEY</code> à{" "}
          <code>.env.local</code> puis redémarrez le serveur.
        </p>
      )}
      {!plan && <p className="text-[11px] text-zinc-500">Ce clip n&apos;a pas encore de plan de montage.</p>}
      {message && (
        <p role="status" aria-live="polite" className="text-[11px] text-zinc-400">
          {message}
        </p>
      )}

      {cards.length === 0 && plan && (
        <p className="text-[11px] text-zinc-500">Aucune carte sur ce clip.</p>
      )}

      <ol className="space-y-2">
        {[...cards]
          .sort((a, b) => a.startSec - b.startSec)
          .map((card) => (
            <li key={card.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                  {KIND_LABELS[card.kind]}
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {card.startSec.toFixed(1)}–{card.endSec.toFixed(1)} s
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{card.text}</span>
                <button
                  type="button"
                  onClick={() => setOpenId(openId === card.id ? null : card.id)}
                  className="rounded border border-white/15 px-2 py-0.5 text-zinc-300 hover:bg-white/10"
                >
                  {openId === card.id ? "Fermer" : readOnly ? "Voir" : "Modifier"}
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Supprimer la carte ${card.text}`}
                    onClick={() => setCards(cards.filter((c) => c.id !== card.id))}
                    className="rounded border border-rose-400/30 px-2 py-0.5 text-rose-300 hover:bg-rose-400/10"
                  >
                    Supprimer
                  </button>
                )}
              </div>

              {openId === card.id && (
                <fieldset disabled={readOnly} className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-zinc-400">
                    Type
                    <select
                      value={card.kind}
                      onChange={(e) => update(card.id, { kind: e.target.value as MotionCardKind })}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                    >
                      {(Object.keys(KIND_LABELS) as MotionCardKind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-zinc-400">
                    Position
                    <select
                      value={card.position}
                      onChange={(e) => update(card.id, { position: e.target.value as MotionCard["position"] })}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
                    >
                      <option value="top">En haut</option>
                      <option value="center">Au centre</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-zinc-400 sm:col-span-2">
                    Texte
                    <input
                      value={card.text}
                      maxLength={MOTION_TEXT_MAX_LENGTH}
                      onChange={(e) => update(card.id, { text: e.target.value })}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-zinc-400 sm:col-span-2">
                    Détail (facultatif)
                    <input
                      value={card.detail ?? ""}
                      maxLength={MOTION_DETAIL_MAX_LENGTH}
                      onChange={(e) => update(card.id, { detail: e.target.value.length > 0 ? e.target.value : null })}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100"
                    />
                  </label>
                  {card.kind === "list" && (
                    <label className="flex flex-col gap-1 text-zinc-400 sm:col-span-2">
                      Points (un par ligne, {MOTION_LIST_MAX_ITEMS} au plus)
                      <textarea
                        value={card.items.join("\n")}
                        rows={MOTION_LIST_MAX_ITEMS}
                        onChange={(e) =>
                          update(card.id, {
                            items: e.target.value
                              .split("\n")
                              .slice(0, MOTION_LIST_MAX_ITEMS)
                              .map((item) => item.slice(0, MOTION_ITEM_MAX_LENGTH)),
                          })
                        }
                        className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100"
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-zinc-400">
                    Début (s)
                    <input
                      type="number"
                      step={0.1}
                      value={card.startSec}
                      onChange={(e) => {
                        const startSec = Number(e.target.value);
                        if (Number.isFinite(startSec)) update(card.id, { startSec, endSec: startSec + (card.endSec - card.startSec) });
                      }}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-zinc-400">
                    Fin (s)
                    <input
                      type="number"
                      step={0.1}
                      value={card.endSec}
                      onChange={(e) => {
                        const endSec = Number(e.target.value);
                        if (Number.isFinite(endSec)) update(card.id, { endSec });
                      }}
                      className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100"
                    />
                  </label>
                </fieldset>
              )}
            </li>
          ))}
      </ol>

      {cards.length >= MAX_MOTION_CARDS_PER_PLAN && (
        <p className="text-[11px] text-zinc-500">{MAX_MOTION_CARDS_PER_PLAN} cartes au plus par clip.</p>
      )}
      {errors.length > 0 && (
        <p role="alert" className="text-[11px] text-rose-300">
          À corriger avant l&apos;export : {errors[0]}
        </p>
      )}
    </div>
  );
}
