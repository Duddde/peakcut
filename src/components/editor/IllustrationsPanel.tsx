"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { Segment } from "@/lib/domain/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import {
  MAX_OVERLAYS_PER_PLAN,
  OVERLAY_FADE_SEC_MAX,
  OVERLAY_OPACITY_MIN,
  type Overlay,
  type RenderPlan,
} from "@/lib/effects/types";
import {
  canAddOverlay,
  defaultOverlayFor,
  patchOverlay,
  planDurationSec,
  withOverlay,
  withoutOverlay,
} from "@/lib/effects/overlayEdits";
import {
  OVERLAY_PLACEMENTS,
  OVERLAY_SIZE_MAX,
  OVERLAY_SIZE_MIN,
  placementOf,
  placementRect,
  sizeOf,
  type OverlayPlacement,
} from "@/lib/effects/overlayPlacement";
import {
  deleteProjectAsset,
  generateProjectAsset,
  listProjectAssets,
  uploadProjectAsset,
  type ProjectAsset,
} from "@/lib/assets/assetClient";

/**
 * Illustrations on a clip: import an image or generate one, then say when
 * and where it appears.
 *
 * The clip's illustrations live in its RenderPlan, which is what the
 * export compiles — so this panel edits the same document as the effects
 * panel and the timeline, and every change goes out through `onChange`
 * for the studio to save. Nothing is stored here.
 *
 * Position is chosen among named places rather than dragged on a canvas
 * (see overlayPlacement): the four that matter on a short, each correct
 * by construction and none of them able to cover the subtitles.
 */

const PLACEMENT_LABELS: Record<OverlayPlacement, string> = {
  top: "En haut",
  center: "Au centre",
  bottom: "En bas",
  full: "Plein cadre",
};

const ORIGIN_LABELS: Record<ProjectAsset["origin"], string> = {
  upload: "Importée",
  generated: "Générée par IA",
};

export interface IllustrationsPanelProps {
  projectId: string;
  segment: Segment;
  readOnly?: boolean;
  onChange: (plan: RenderPlan) => void;
  onReadOnlyAttempt?: () => void;
  /** Injected in tests so no request is ever made. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to crypto.randomUUID(). */
  newId?: () => string;
  /** True when the account cannot generate (public trial, or no provider configured). */
  generationAvailable?: boolean;
}

export function IllustrationsPanel({
  projectId,
  segment,
  readOnly = false,
  onChange,
  onReadOnlyAttempt,
  fetchImpl,
  newId,
  generationAvailable = true,
}: IllustrationsPanelProps) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "uploading" | "generating">(null);
  const [prompt, setPrompt] = useState("");
  /**
   * Whether any generator is actually configured on this server. It
   * starts as true so the button is never disabled on a slow or failed
   * directory request: in that case the attempt itself reports the real
   * reason, which beats greying out a feature that may well work.
   */
  const [providerConfigured, setProviderConfigured] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listProjectAssets(projectId, fetchImpl)
      .then((loaded) => {
        if (cancelled) return;
        setAssets(loaded);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Échec du chargement des illustrations.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fetchImpl]);

  useEffect(() => {
    let cancelled = false;
    (fetchImpl ?? fetch)("/api/image-providers")
      .then((res) => res.json())
      .then((json: unknown) => {
        if (cancelled) return;
        const providers = (json as { providers?: unknown }).providers;
        if (!Array.isArray(providers)) return;
        setProviderConfigured(
          providers.some((p) => typeof p === "object" && p !== null && (p as { configured?: unknown }).configured === true)
        );
      })
      .catch(() => {
        // Informational only; see providerConfigured.
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  /**
   * A clip with no plan gets one the moment an illustration is added,
   * instead of refusing until a template is picked: illustrations live in
   * the plan, and "choose an effect first" would be an implementation
   * detail asked of the user.
   */
  function planOf(): RenderPlan {
    return (
      segment.renderPlan ??
      buildRenderPlan("clean-captions", {
        segmentId: segment.id,
        segmentDurationSec: Math.max(0, segment.endSec - segment.startSec),
      })
    );
  }

  function guard(apply: () => void) {
    if (readOnly) {
      onReadOnlyAttempt?.();
      return;
    }
    apply();
  }

  function addToClip(asset: ProjectAsset) {
    guard(() => {
      const plan = planOf();
      if (!canAddOverlay(plan)) {
        setError(`Ce clip a déjà ${MAX_OVERLAYS_PER_PLAN} illustrations, le maximum.`);
        return;
      }
      setError(null);
      onChange(
        withOverlay(
          plan,
          defaultOverlayFor({
            assetId: asset.id,
            id: (newId ?? (() => crypto.randomUUID()))(),
            durationSec: planDurationSec(plan),
            index: plan.overlays.length,
          })
        )
      );
    });
  }

  async function handleUpload(file: File) {
    setBusy("uploading");
    setError(null);
    try {
      const asset = await uploadProjectAsset(projectId, file, fetchImpl);
      setAssets((current) => [asset, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'import de l'image.");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleGenerate() {
    setBusy("generating");
    setError(null);
    try {
      const asset = await generateProjectAsset(projectId, { prompt, aspect: "portrait" }, fetchImpl);
      setAssets((current) => [asset, ...current]);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la génération de l'image.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteAsset(asset: ProjectAsset) {
    setError(null);
    try {
      await deleteProjectAsset(projectId, asset.id, fetchImpl);
      setAssets((current) => current.filter((a) => a.id !== asset.id));
      // Any clip still showing it would export without it; drop it from
      // this one so what the panel shows and what the export does agree.
      const plan = segment.renderPlan;
      if (plan && plan.overlays.some((overlay) => overlay.assetId === asset.id)) {
        onChange({
          ...plan,
          overlays: plan.overlays.filter((overlay) => overlay.assetId !== asset.id),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la suppression de l'illustration.");
    }
  }

  const canGenerate = generationAvailable && providerConfigured;

  const plan = segment.renderPlan;
  const overlays = plan?.overlays ?? [];
  const clipDurationSec = plan ? planDurationSec(plan) : Math.max(0, segment.endSec - segment.startSec);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  function updateOverlay(overlay: Overlay, patch: Parameters<typeof patchOverlay>[2]) {
    guard(() => {
      if (!plan) return;
      onChange(patchOverlay(plan, overlay.id, patch));
    });
  }

  return (
    <section data-testid="illustrations-panel" className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">Illustrations du clip</h4>
        <p className="text-[11px] text-zinc-500">
          Une image posée sur la vidéo pendant quelques secondes. Elle est incrustée à l&apos;export, au
          même endroit et au même moment qu&apos;ici.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-zinc-200 transition hover:bg-white/10">
          Importer une image
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Importer une image"
            disabled={readOnly || busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
            className="hidden"
          />
        </label>
        {busy === "uploading" && <span className="text-[11px] text-zinc-400">Import en cours…</span>}
      </div>

      <div className="space-y-1">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Générer une illustration
          <input
            type="text"
            aria-label="Décrire l'image à générer"
            placeholder="un graphique qui monte, style minimaliste"
            value={prompt}
            disabled={readOnly || !canGenerate || busy !== null}
            onChange={(e) => setPrompt(e.target.value)}
            className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-400/60 disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={readOnly || !canGenerate || busy !== null || prompt.trim().length < 3}
          className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "generating" ? "Génération…" : "Générer"}
        </button>
        {!canGenerate && (
          <p className="text-[11px] text-zinc-500">
            La génération d&apos;images par IA n&apos;est pas disponible ici : elle demande un compte et un
            fournisseur configuré sur le serveur.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Images du projet ({assets.length})
        </h5>
        {loading && <p className="text-[11px] text-zinc-400">Chargement…</p>}
        {assets.length === 0 && !loading && (
          <p className="text-[11px] text-zinc-500">Aucune image pour l&apos;instant.</p>
        )}
        <ul className="space-y-1">
          {assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center gap-2 rounded border border-white/10 bg-white/5 px-2 py-1"
            >
              <Image
                src={asset.url}
                alt={asset.prompt ?? "Illustration importée"}
                width={32}
                height={32}
                unoptimized
                className="h-8 w-8 rounded object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                {asset.prompt ?? ORIGIN_LABELS[asset.origin]}
              </span>
              <button
                type="button"
                onClick={() => addToClip(asset)}
                className="rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-zinc-200 transition hover:bg-white/10"
              >
                Ajouter au clip
              </button>
              <button
                type="button"
                aria-label={`Supprimer l'image ${asset.prompt ?? asset.id}`}
                onClick={() => void handleDeleteAsset(asset)}
                className="rounded border border-rose-400/30 px-1.5 py-0.5 text-[11px] text-rose-300 transition hover:bg-rose-400/20"
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Sur ce clip ({overlays.length})
        </h5>
        {overlays.length === 0 ? (
          <p className="text-[11px] text-zinc-500">
            Aucune illustration sur ce clip. Ajoutez-en une depuis la liste ci-dessus.
          </p>
        ) : (
          <ul className="space-y-2">
            {overlays.map((overlay) => {
              const asset = assetById.get(overlay.assetId);
              return (
                <li key={overlay.id} className="space-y-1 rounded border border-white/10 bg-white/5 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                      {asset ? (asset.prompt ?? ORIGIN_LABELS[asset.origin]) : "Image introuvable"}
                    </span>
                    <button
                      type="button"
                      aria-label={`Retirer l'illustration ${overlay.id}`}
                      onClick={() => guard(() => plan && onChange(withoutOverlay(plan, overlay.id)))}
                      className="rounded border border-rose-400/30 px-1.5 py-0.5 text-[11px] text-rose-300 transition hover:bg-rose-400/20"
                    >
                      Retirer
                    </button>
                  </div>

                  {!asset && (
                    <p className="text-[11px] text-amber-300">
                      Cette image n&apos;est plus dans le projet : le clip s&apos;exportera sans elle.
                    </p>
                  )}

                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Début (s)
                      <input
                        type="number"
                        aria-label={`Début de l'illustration ${overlay.id}`}
                        min={0}
                        max={clipDurationSec}
                        step={0.1}
                        value={overlay.startSec.toFixed(1)}
                        onChange={(e) => updateOverlay(overlay, { startSec: Number(e.target.value) })}
                        className="w-20 rounded border border-white/10 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Fin (s)
                      <input
                        type="number"
                        aria-label={`Fin de l'illustration ${overlay.id}`}
                        min={0}
                        max={clipDurationSec}
                        step={0.1}
                        value={overlay.endSec.toFixed(1)}
                        onChange={(e) => updateOverlay(overlay, { endSec: Number(e.target.value) })}
                        className="w-20 rounded border border-white/10 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Position
                      <select
                        aria-label={`Position de l'illustration ${overlay.id}`}
                        value={placementOf(overlay.rect)}
                        onChange={(e) =>
                          updateOverlay(overlay, {
                            rect: placementRect(e.target.value as OverlayPlacement, sizeOf(overlay.rect)),
                          })
                        }
                        className="rounded border border-white/10 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
                      >
                        {OVERLAY_PLACEMENTS.map((placement) => (
                          <option key={placement} value={placement}>
                            {PLACEMENT_LABELS[placement]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Taille ({Math.round(sizeOf(overlay.rect) * 100)}%)
                      <input
                        type="range"
                        aria-label={`Taille de l'illustration ${overlay.id}`}
                        min={OVERLAY_SIZE_MIN}
                        max={OVERLAY_SIZE_MAX}
                        step={0.05}
                        value={sizeOf(overlay.rect)}
                        onChange={(e) =>
                          updateOverlay(overlay, {
                            rect: placementRect(placementOf(overlay.rect), Number(e.target.value)),
                          })
                        }
                        className="accent-amber-400"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Opacité ({Math.round(overlay.opacity * 100)}%)
                      <input
                        type="range"
                        aria-label={`Opacité de l'illustration ${overlay.id}`}
                        min={OVERLAY_OPACITY_MIN}
                        max={1}
                        step={0.05}
                        value={overlay.opacity}
                        onChange={(e) => updateOverlay(overlay, { opacity: Number(e.target.value) })}
                        className="accent-amber-400"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
                      Fondu ({overlay.fadeSec.toFixed(2)}s)
                      <input
                        type="range"
                        aria-label={`Fondu de l'illustration ${overlay.id}`}
                        min={0}
                        max={OVERLAY_FADE_SEC_MAX}
                        step={0.05}
                        value={overlay.fadeSec}
                        onChange={(e) => updateOverlay(overlay, { fadeSec: Number(e.target.value) })}
                        className="accent-amber-400"
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
