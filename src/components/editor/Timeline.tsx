import type { Segment } from "@/lib/domain/types";

export function Timeline({
  segments,
  totalDurationSec,
  selectedSegmentId,
  onSelect,
}: {
  segments: Segment[];
  totalDurationSec: number;
  selectedSegmentId: string;
  onSelect: (id: string) => void;
}) {
  const total = totalDurationSec || 1;
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Timeline ({total.toFixed(1)}s)
      </h4>
      <div
        role="listbox"
        aria-label="Segments sur la timeline"
        className="relative flex h-10 w-full overflow-hidden rounded-lg border border-white/10 bg-white/5"
      >
        {segments.map((segment) => {
          const widthPct = Math.max(
            2,
            ((segment.endSec - segment.startSec) / total) * 100
          );
          const isSelected = segment.id === selectedSegmentId;
          return (
            <button
              key={segment.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(segment.id)}
              style={{ width: `${widthPct}%` }}
              className={`h-full border-r border-zinc-950/60 px-2 text-left text-[11px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                isSelected
                  ? "bg-amber-400 text-zinc-950"
                  : "bg-transparent text-zinc-300 hover:bg-white/10"
              }`}
              title={`${segment.title} (${segment.startSec.toFixed(1)}s–${segment.endSec.toFixed(1)}s)`}
            >
              <span className="block truncate">{segment.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
