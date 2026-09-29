/**
 * Small, curated, deterministic French-leaning lexicons used by the
 * explainable scorer. These are intentionally simple word lists rather than
 * a statistical model, so every score can be traced back to a concrete
 * matched word. All lexicon entries are stored accent-stripped and
 * lower-cased; match them against words run through normalizeWord().
 */

const ACCENT_MAP: Record<string, string> = {
  à: "a",
  â: "a",
  ä: "a",
  á: "a",
  é: "e",
  è: "e",
  ê: "e",
  ë: "e",
  î: "i",
  ï: "i",
  ô: "o",
  ö: "o",
  ù: "u",
  û: "u",
  ü: "u",
  ç: "c",
  œ: "oe",
};

export function normalizeWord(raw: string): string {
  const lowered = raw.toLowerCase();
  let out = "";
  for (const ch of lowered) {
    out += ACCENT_MAP[ch] ?? ch;
  }
  return out.replace(/[^a-z0-9'-]/g, "");
}

function normalizeList(words: string[]): string[] {
  return words.map(normalizeWord);
}

export const HOOK_KEYWORDS = normalizeList([
  "secret",
  "secrets",
  "jamais",
  "personne",
  "incroyable",
  "choquant",
  "choqué",
  "choquée",
  "astuce",
  "astuces",
  "erreur",
  "erreurs",
  "vérité",
  "attention",
  "arrête",
  "arrêtez",
  "regarde",
  "regardez",
  "imagine",
  "imaginez",
]);

export const EMOTION_WORDS = normalizeList([
  "choqué",
  "choquée",
  "choquant",
  "incroyable",
  "heureux",
  "heureuse",
  "triste",
  "peur",
  "colère",
  "énervé",
  "énervée",
  "pleuré",
  "pleure",
  "adorable",
  "horrible",
  "magnifique",
  "tellement",
  "incroyablement",
  "bouleversé",
  "bouleversée",
]);

/**
 * Single-token filler words. Deliberately narrow: words like "en" or "fait"
 * are excluded even though they appear inside filler phrases ("en fait"),
 * because they are also ordinary, meaningful French words on their own.
 */
export const FILLER_WORDS = normalizeList([
  "euh",
  "heu",
  "hum",
  "genre",
  "voilà",
  "quoi",
  "bah",
  "bref",
]);

export const STOPWORDS = new Set(
  normalizeList([
    "le",
    "la",
    "les",
    "un",
    "une",
    "des",
    "de",
    "du",
    "et",
    "à",
    "au",
    "aux",
    "ce",
    "ces",
    "cet",
    "cette",
    "que",
    "qui",
    "quoi",
    "je",
    "tu",
    "il",
    "elle",
    "on",
    "nous",
    "vous",
    "ils",
    "elles",
    "se",
    "sa",
    "son",
    "ses",
    "mon",
    "ma",
    "mes",
    "ton",
    "ta",
    "tes",
    "est",
    "sont",
    "être",
    "avoir",
    "ai",
    "as",
    "a",
    "ont",
    "pour",
    "par",
    "sur",
    "dans",
    "avec",
    "sans",
    "pas",
    "ne",
    "en",
    "dire",
    "va",
    "vais",
    "voici",
  ])
);
