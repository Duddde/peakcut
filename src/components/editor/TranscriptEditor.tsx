import type { TranscriptWord } from "@/lib/domain/types";

export function TranscriptEditor({
  words,
  onChangeWord,
  readOnly = false,
}: {
  words: TranscriptWord[];
  onChangeWord: (index: number, patch: Partial<TranscriptWord>) => void;
  /** Public demo: words stay visible and focusable but cannot be edited. */
  readOnly?: boolean;
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Transcript mot-à-mot {readOnly ? "(lecture seule)" : "(éditable)"}
      </h4>
      <ul className="flex max-h-56 flex-wrap gap-2 overflow-y-auto rounded-lg border border-white/10 bg-white/5 p-3">
        {words.map((word, index) => (
          <li key={index} className="flex flex-col items-stretch gap-1">
            <label className="sr-only" htmlFor={`word-text-${index}`}>
              Mot {index + 1}
            </label>
            <input
              id={`word-text-${index}`}
              type="text"
              readOnly={readOnly}
              value={word.text}
              onChange={(e) => onChangeWord(index, { text: e.target.value })}
              className="w-24 rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-400/60"
            />
            <div className="flex gap-1 text-[10px] text-zinc-500">
              <input
                aria-label={`Début du mot ${index + 1} en secondes`}
                type="number"
                step={0.05}
                readOnly={readOnly}
                value={word.startSec}
                onChange={(e) => onChangeWord(index, { startSec: Number(e.target.value) })}
                className="w-11 rounded border border-white/10 bg-zinc-900 px-1 py-0.5 text-zinc-300"
              />
              <input
                aria-label={`Fin du mot ${index + 1} en secondes`}
                type="number"
                step={0.05}
                readOnly={readOnly}
                value={word.endSec}
                onChange={(e) => onChangeWord(index, { endSec: Number(e.target.value) })}
                className="w-11 rounded border border-white/10 bg-zinc-900 px-1 py-0.5 text-zinc-300"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
