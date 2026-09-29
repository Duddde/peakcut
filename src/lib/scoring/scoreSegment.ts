import type { Score, ScoreBreakdown, TranscriptWord } from "@/lib/domain/types";
import {
  EMOTION_WORDS,
  FILLER_WORDS,
  HOOK_KEYWORDS,
  STOPWORDS,
  normalizeWord,
} from "./lexicon";

/**
 * Explainable, deterministic, rule-based scorer for a candidate short-form
 * segment.
 *
 * IMPORTANT: this produces an *editorial interest* score built from
 * transparent, inspectable heuristics (hook strength, lexical density,
 * presence of a question, emotional language, speaker changes, duration
 * fit, and quality penalties). It is NOT a prediction of watch time, views,
 * completion rate, or virality, and must never be presented as one. Every
 * non-zero factor is traceable to a reason string in `explanation`.
 */

export interface ScoreSegmentInput {
  words: TranscriptWord[];
  startSec: number;
  endSec: number;
}

const WEIGHTS: Record<keyof Omit<ScoreBreakdown, "penalties">, number> = {
  hook: 0.25,
  lexicalDensity: 0.15,
  question: 0.15,
  emotion: 0.15,
  speakerChange: 0.1,
  duration: 0.2,
};

const MAX_HOOK_WINDOW = 10;
const SPEAKER_CHANGE_NORMALIZER = 3;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const MAX_LOW_CONFIDENCE_PENALTY = 0.2;
const LOW_WORD_COUNT_THRESHOLD = 5;
const LOW_WORD_COUNT_PENALTY = 0.15;
const FILLER_RATIO_THRESHOLD = 0.3;
const MAX_FILLER_PENALTY = 0.2;
const CONFIDENCE_LENGTH_NORMALIZER = 15;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function durationFactor(durationSec: number): number {
  if (durationSec <= 3) return 0;
  if (durationSec < 15) return (durationSec - 3) / 12;
  if (durationSec <= 45) return 1;
  if (durationSec < 90) return 1 - (durationSec - 45) / 45;
  return 0;
}

function emptyScore(): Score {
  return {
    value: 0,
    confidence: 0,
    explanation: {
      breakdown: {
        hook: 0,
        lexicalDensity: 0,
        question: 0,
        emotion: 0,
        speakerChange: 0,
        duration: 0,
        penalties: 0,
      },
      reasons: [],
      penaltyReasons: ["Segment vide : aucun mot à analyser."],
    },
  };
}

export function scoreSegment(input: ScoreSegmentInput): Score {
  const { words, startSec, endSec } = input;

  if (words.length === 0) {
    return emptyScore();
  }

  const reasons: string[] = [];
  const penaltyReasons: string[] = [];

  const tokens = words.map((w) => normalizeWord(w.text)).filter((t) => t.length > 0);

  // --- Hook: opening words judged for curiosity keywords and numbers ---
  const openingTokens = tokens.slice(0, MAX_HOOK_WINDOW);
  const matchedHookKeyword = openingTokens.find((t) => HOOK_KEYWORDS.includes(t));
  const hasNumber = openingTokens.some((t) => /^\d+$/.test(t));
  let hook = 0;
  if (hasNumber) hook += 0.4;
  if (matchedHookKeyword) hook += 0.6;
  hook = clamp01(hook);
  if (hasNumber) reasons.push("Accroche : la phrase d'ouverture contient un chiffre, souvent efficace pour capter l'attention.");
  if (matchedHookKeyword) {
    reasons.push(`Accroche : mot de curiosité détecté dans les premiers mots (« ${matchedHookKeyword} »).`);
  }

  // --- Lexical density: distinct meaningful words / total words ---
  const meaningfulTokens = tokens.filter((t) => !STOPWORDS.has(t));
  const distinctMeaningful = new Set(meaningfulTokens);
  const lexicalDensity = tokens.length > 0 ? clamp01(distinctMeaningful.size / tokens.length) : 0;
  if (lexicalDensity > 0.4) {
    reasons.push(
      `Densité lexicale élevée : ${distinctMeaningful.size} mots porteurs de sens distincts sur ${tokens.length} mots.`
    );
  }

  // --- Question presence ---
  const question = words.some((w) => w.text.includes("?")) ? 1 : 0;
  if (question) reasons.push("Une question est posée, ce qui invite à la curiosité.");

  // --- Emotion words ---
  const emotionMatches = tokens.filter((t) => EMOTION_WORDS.includes(t));
  const emotion = tokens.length > 0 ? clamp01((emotionMatches.length / tokens.length) * 2.5) : 0;
  if (emotionMatches.length > 0) {
    reasons.push(
      `Langage émotionnel détecté (${emotionMatches.length} mot(s) : « ${[...new Set(emotionMatches)].join(", ")} »).`
    );
  }

  // --- Speaker changes ---
  let speakerTransitions = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i].speaker && words[i - 1].speaker && words[i].speaker !== words[i - 1].speaker) {
      speakerTransitions++;
    }
  }
  const speakerChange = clamp01(speakerTransitions / SPEAKER_CHANGE_NORMALIZER);
  if (speakerTransitions > 0) {
    reasons.push(`${speakerTransitions} changement(s) de locuteur détecté(s), ce qui dynamise le segment.`);
  }

  // --- Duration fit ---
  const durationSec = Math.max(0, endSec - startSec);
  const duration = durationFactor(durationSec);
  if (duration >= 0.8) {
    reasons.push(`Durée proche de l'idéal pour un format court (${durationSec.toFixed(1)}s).`);
  }

  // --- Penalties ---
  let penalties = 0;

  if (tokens.length < LOW_WORD_COUNT_THRESHOLD) {
    penalties += LOW_WORD_COUNT_PENALTY;
    penaltyReasons.push(
      `Segment très court (${tokens.length} mot(s)) : le score est moins fiable.`
    );
  }

  const avgConfidence =
    words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
  if (avgConfidence < LOW_CONFIDENCE_THRESHOLD) {
    const confidencePenalty = clamp01(
      ((LOW_CONFIDENCE_THRESHOLD - avgConfidence) / LOW_CONFIDENCE_THRESHOLD) *
        MAX_LOW_CONFIDENCE_PENALTY
    );
    penalties += Math.min(MAX_LOW_CONFIDENCE_PENALTY, confidencePenalty);
    penaltyReasons.push(
      `Confiance de transcription faible (${Math.round(avgConfidence * 100)}%) : à vérifier manuellement.`
    );
  }

  const fillerCount = tokens.filter((t) => FILLER_WORDS.includes(t)).length;
  const fillerRatio = tokens.length > 0 ? fillerCount / tokens.length : 0;
  if (fillerRatio > FILLER_RATIO_THRESHOLD) {
    penalties += Math.min(MAX_FILLER_PENALTY, fillerRatio);
    penaltyReasons.push(
      `Segment riche en mots de remplissage (${Math.round(fillerRatio * 100)}% des mots).`
    );
  }

  penalties = clamp01(penalties);

  const breakdown: ScoreBreakdown = {
    hook,
    lexicalDensity,
    question,
    emotion,
    speakerChange,
    duration,
    penalties,
  };

  const rawWeightedSum =
    hook * WEIGHTS.hook +
    lexicalDensity * WEIGHTS.lexicalDensity +
    question * WEIGHTS.question +
    emotion * WEIGHTS.emotion +
    speakerChange * WEIGHTS.speakerChange +
    duration * WEIGHTS.duration;

  const value = Math.round(clamp01(rawWeightedSum - penalties) * 100);

  const lengthFactor = clamp01(tokens.length / CONFIDENCE_LENGTH_NORMALIZER);
  const confidence = clamp01(avgConfidence * lengthFactor);

  return {
    value,
    confidence,
    explanation: {
      breakdown,
      reasons,
      penaltyReasons,
    },
  };
}
