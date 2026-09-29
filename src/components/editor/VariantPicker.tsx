import type { Variant } from "@/lib/domain/types";
import { FramePreview } from "./FramePreview";

export function VariantPicker({
  variants,
  selectedVariantId,
  onSelect,
  onChangeCrop,
}: {
  variants: Variant[];
  selectedVariantId: string;
  onSelect: (id: string) => void;
  onChangeCrop: (id: string, patch: Partial<Variant["crop"]>) => void;
}) {
  const selected = variants.find((v) => v.id === selectedVariantId) ?? variants[0];
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Cadrage &amp; variantes
      </h4>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Choisir une variante de cadrage">
        {variants.map((variant) => (
          <button
            key={variant.id}
            type="button"
            role="tab"
            aria-selected={variant.id === selected.id}
            onClick={() => onSelect(variant.id)}
            className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
              variant.id === selected.id
                ? "border-amber-400 bg-amber-400/10 text-amber-300"
                : "border-white/10 text-zinc-400 hover:border-white/30"
            }`}
          >
            {variant.aspectRatio}
          </button>
        ))}
      </div>

      <FramePreview crop={selected.crop} safeZones={[]} />

      <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
        {(["x", "y", "width", "height"] as const).map((field) => (
          <label key={field} className="flex flex-col gap-1 text-zinc-500">
            {field}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={selected.crop[field]}
              onChange={(e) => onChangeCrop(selected.id, { [field]: Number(e.target.value) })}
              className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-200"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
