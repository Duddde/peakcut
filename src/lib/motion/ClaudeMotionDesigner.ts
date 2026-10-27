import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { TranscriptWord } from "@/lib/domain/types";
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
} from "./types";

/**
 * Claude Motion: Claude reads what is said in a clip and designs the
 * animated cards that illustrate it — the phrase to remember, the figure,
 * the list being counted off, the line worth quoting — each timed to the
 * moment it is said.
 *
 * Claude proposes; nothing it returns reaches the render as is. Every card
 * is brought inside the bounds the plan validator enforces (timing,
 * lengths, count, no overlap) by sanitizeMotionCards, and the editor can
 * change or delete each one in the studio.
 */

export const CLAUDE_MOTION_MODEL = "claude-opus-5-5";

/** Whether a Claude credential is configured on this server. Read per call, never exposed to the client. */
export function isClaudeMotionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

export class ClaudeMotionNotConfiguredError extends Error {
  constructor() {
    super("Claude Motion n'est pas configuré (ANTHROPIC_API_KEY manquant).");
    this.name = "ClaudeMotionNotConfiguredError";
  }
}

export class ClaudeMotionError extends Error {
  constructor(message: string) {
    super(`Claude Motion : ${message}`);
    this.name = "ClaudeMotionError";
  }
}

const CardSchema = z.object({
  kind: z.enum(["keyword", "stat", "list", "quote"]),
  text: z.string(),
  detail: z.string().nullable(),
  items: z.array(z.string()),
  startSec: z.number(),
  endSec: z.number(),
  position: z.enum(["top", "center"]),
});
const DesignSchema = z.object({ cards: z.array(CardSchema) });
type DesignedCard = z.infer<typeof CardSchema>;

const SYSTEM_PROMPT = `Tu es motion designer pour des vidéos verticales courtes (Shorts, Reels, TikTok).
On te donne la transcription horodatée d'un extrait. Tu conçois des cartes animées qui illustrent le propos au moment où il est dit, par-dessus la vidéo.

Types de cartes :
- "keyword" : l'idée clé en quelques mots (pas une phrase recopiée). "detail" : une courte précision, ou null.
- "stat" : un chiffre, un montant, une durée, un score réellement prononcé. "text" = la valeur ("3 000 €", "17 ans"), "detail" = ce qu'elle mesure.
- "list" : quand l'orateur énumère. "text" = le titre, "items" = 2 à 4 points très courts.
- "quote" : la phrase forte, mot pour mot ou presque. "detail" = qui la dit si on le sait, sinon null.

Règles :
- Peu de cartes, mais justes : une carte toutes les 6 à 12 secondes au plus, uniquement quand elle apporte quelque chose. Mieux vaut aucune carte qu'une carte décorative.
- Chaque carte commence quand l'idée est dite (au plus 0,3 s avant), dure de 1,5 à 5 s, et ne chevauche aucune autre carte.
- "text" : 40 caractères au plus. "detail" : 60 au plus. Points de liste : 28 au plus. "items" est vide sauf pour "list".
- N'invente aucun chiffre, nom ou fait absent de la transcription. Écris dans la langue de la transcription.
- "position" : "top" en général ; "center" seulement pour un chiffre ou une citation qui doit frapper.
- Les temps sont en secondes depuis le début de l'extrait.`;

/** The clip's words as timed lines, one per phrase: what Claude times the cards against. */
export function transcriptLines(words: TranscriptWord[], clipStartSec: number): string {
  const lines: string[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const at = (current[0].startSec - clipStartSec).toFixed(1);
    const speaker = current[0].speaker ? ` (${current[0].speaker})` : "";
    lines.push(`[${at}s]${speaker} ${current.map((w) => w.text).join(" ")}`);
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && (word.speaker !== previous.speaker || word.startSec - previous.endSec > 0.6 || current.length >= 18)) {
      flush();
    }
    current.push(word);
    if (/[.!?…]["»)]*$/.test(word.text.trim())) flush();
  }
  flush();
  return lines.join("\n");
}

/** Cuts a text to `max` characters on a word boundary. */
function fit(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Claude's proposal brought inside the plan's bounds: times inside the
 * clip and long enough to read, texts to length, items only on lists, one
 * card at a time, at most the cap — the result always validates.
 */
export function sanitizeMotionCards(cards: DesignedCard[], clipDurationSec: number): MotionCard[] {
  const shaped = cards
    .map((card) => {
      const startSec = Math.min(Math.max(0, card.startSec), Math.max(0, clipDurationSec - MIN_MOTION_CARD_SEC));
      const wanted = Math.max(card.endSec - card.startSec, MIN_MOTION_CARD_SEC);
      const endSec = Math.min(clipDurationSec, startSec + Math.min(wanted, MAX_MOTION_CARD_SEC));
      const items = card.kind === "list" ? card.items.map((item) => fit(item, MOTION_ITEM_MAX_LENGTH)).filter(Boolean).slice(0, MOTION_LIST_MAX_ITEMS) : [];
      const detail = card.detail ? fit(card.detail, MOTION_DETAIL_MAX_LENGTH) : "";
      return {
        kind: card.kind,
        text: fit(card.text, MOTION_TEXT_MAX_LENGTH),
        detail: detail.length > 0 ? detail : null,
        items,
        startSec,
        endSec,
        position: card.position,
      };
    })
    .filter((card) => card.text.length > 0 && card.endSec - card.startSec >= MIN_MOTION_CARD_SEC - 1e-6)
    .sort((a, b) => a.startSec - b.startSec);

  // One card at a time: a card that starts before the previous one ends
  // starts when it ends, if it is still readable then; otherwise it goes.
  const kept: Omit<MotionCard, "id">[] = [];
  for (const card of shaped) {
    const previous = kept[kept.length - 1];
    if (previous && card.startSec < previous.endSec) {
      const startSec = previous.endSec;
      if (card.endSec - startSec < MIN_MOTION_CARD_SEC) continue;
      kept.push({ ...card, startSec });
      continue;
    }
    kept.push(card);
    if (kept.length >= MAX_MOTION_CARDS_PER_PLAN) break;
  }
  const result = kept.slice(0, MAX_MOTION_CARDS_PER_PLAN).map((card, index) => ({ id: `motion-${index + 1}`, ...card }));
  const errors = validateMotionCards(result, clipDurationSec);
  if (errors.length > 0) throw new ClaudeMotionError(`cartes invalides après nettoyage (${errors[0]})`);
  return result;
}

export interface DesignMotionInput {
  /** Every word of the clip, absolute times. */
  words: TranscriptWord[];
  clipStartSec: number;
  clipEndSec: number;
  title?: string;
}

export interface ClaudeMotionDesignerDeps {
  /** Injected in tests; defaults to a client reading the environment's credentials. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeMotionDesigner {
  constructor(private readonly deps: ClaudeMotionDesignerDeps = {}) {}

  async design(input: DesignMotionInput): Promise<MotionCard[]> {
    if (!this.deps.client && !isClaudeMotionConfigured(this.deps.env)) throw new ClaudeMotionNotConfiguredError();
    const clipDurationSec = input.clipEndSec - input.clipStartSec;
    const words = input.words.filter((w) => w.startSec >= input.clipStartSec && w.startSec < input.clipEndSec);
    if (words.length === 0 || !(clipDurationSec > MIN_MOTION_CARD_SEC)) return [];

    const client = this.deps.client ?? new Anthropic();
    const content = [
      input.title ? `Titre de l'extrait : ${input.title}` : null,
      `Durée de l'extrait : ${clipDurationSec.toFixed(1)} s`,
      "",
      "Transcription horodatée :",
      transcriptLines(words, input.clipStartSec),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    let response;
    try {
      response = await client.beta.messages.parse({
        model: CLAUDE_MOTION_MODEL,
        max_tokens: 16000,
        // A declined request is re-run on the fallback model the server
        // picks for the refusal's category, inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        output_config: { effort: "medium", format: betaZodOutputFormat(DesignSchema) },
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ClaudeMotionError("clé Anthropic refusée.");
      if (err instanceof Anthropic.RateLimitError) throw new ClaudeMotionError("limite de débit atteinte, réessayez plus tard.");
      if (err instanceof Anthropic.APIError) throw new ClaudeMotionError(`erreur de l'API (${err.status ?? "réseau"}) : ${err.message}`);
      throw err;
    }

    if (response.stop_reason === "refusal") {
      throw new ClaudeMotionError("la demande a été refusée par les garde-fous du modèle.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new ClaudeMotionError("réponse tronquée (limite de longueur atteinte).");
    }
    if (!response.parsed_output) {
      throw new ClaudeMotionError("réponse illisible (format inattendu).");
    }
    return sanitizeMotionCards(response.parsed_output.cards, clipDurationSec);
  }
}
