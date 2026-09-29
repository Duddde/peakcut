import type { ScoreBreakdown } from "@/lib/domain/types";

/**
 * Derives human-readable category tags from a score breakdown, purely by
 * thresholding each explainable factor. This is presentation sugar on top
 * of the scorer — it introduces no new signal and never reads `penalties`
 * (a penalty is a deduction, not a positive category).
 */

const THRESHOLD = 0.5;

const FACTOR_CATEGORY_ORDER: Array<{ factor: keyof Omit<ScoreBreakdown, "penalties">; category: string }> = [
  { factor: "hook", category: "accroche" },
  { factor: "question", category: "question" },
  { factor: "emotion", category: "émotion" },
  { factor: "speakerChange", category: "dialogue" },
  { factor: "duration", category: "durée-idéale" },
  { factor: "lexicalDensity", category: "dense" },
];

export function deriveCategories(breakdown: ScoreBreakdown): string[] {
  return FACTOR_CATEGORY_ORDER.filter(({ factor }) => breakdown[factor] >= THRESHOLD).map(
    ({ category }) => category
  );
}
