import type { NormalizedRect, SafeZone } from "@/lib/domain/types";

function rectStyle(rect: NormalizedRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export function FramePreview({
  crop,
  safeZones,
}: {
  crop: NormalizedRect;
  safeZones: SafeZone[];
}) {
  return (
    <div>
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-dashed border-white/20 bg-zinc-900">
        <p className="absolute inset-0 flex items-center justify-center text-center text-xs text-zinc-600">
          Aucun média chargé — aperçu du cadrage en mode texte/coordonnées
        </p>
        {safeZones.map((zone) => (
          <div
            key={zone.id}
            title={zone.label}
            className="absolute border border-sky-400/50 bg-sky-400/10"
            style={rectStyle(zone.rect)}
          />
        ))}
        <div
          className="absolute border-2 border-amber-400"
          style={rectStyle(crop)}
          aria-hidden="true"
        />
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        Cadre ambre = crop sélectionné · zones bleues = safe zones (sous-titres / UI plateforme)
      </p>
    </div>
  );
}
