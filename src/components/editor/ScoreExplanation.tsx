import type { Score } from "@/lib/domain/types";

const FACTOR_LABELS: Record<string, string> = {
  hook: "Accroche",
  lexicalDensity: "Densité lexicale",
  question: "Question",
  emotion: "Émotion",
  speakerChange: "Changement de locuteur",
  duration: "Durée",
};

function Bar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-40 shrink-0 text-zinc-400">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-amber-400"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-zinc-500">{pct}%</span>
    </div>
  );
}

export function ScoreExplanation({ score }: { score: Score }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold text-amber-300">{score.value}</span>
        <span className="text-sm text-zinc-500">/ 100 — score éditorial explicable</span>
      </div>
      <p className="text-xs text-zinc-500">
        Confiance du score : {Math.round(score.confidence * 100)}%. Ce n&apos;est ni un temps de
        visionnage estimé, ni une garantie de viralité — seulement des signaux éditoriaux
        transparents.
      </p>

      <div className="space-y-1.5">
        {Object.entries(score.explanation.breakdown)
          .filter(([key]) => key !== "penalties")
          .map(([key, value]) => (
            <Bar key={key} label={FACTOR_LABELS[key] ?? key} value={value as number} />
          ))}
      </div>

      {score.explanation.reasons.length > 0 && (
        <ul className="space-y-1 text-xs text-zinc-400">
          {score.explanation.reasons.map((reason, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true" className="text-emerald-400">
                +
              </span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {score.explanation.penaltyReasons.length > 0 && (
        <ul className="space-y-1 text-xs text-rose-300">
          {score.explanation.penaltyReasons.map((reason, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">−</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
