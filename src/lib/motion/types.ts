/**
 * Claude Motion: animated cards that illustrate what is being said — the
 * key phrase, the figure, the list, the line worth quoting — timed to the
 * moment it is said, laid over the clip.
 *
 * A card is data, not a render: the export and the preview both draw it
 * as animated events of the clip's subtitle track (see compileMotionAss),
 * so what the studio previews is what the file contains. Claude proposes
 * the cards (see ClaudeMotionDesigner); the editor can change or remove
 * every one of them.
 */

export type MotionCardKind = "keyword" | "stat" | "list" | "quote";
export const MOTION_CARD_KINDS: MotionCardKind[] = ["keyword", "stat", "list", "quote"];

export type MotionCardPosition = "top" | "center";
export const MOTION_CARD_POSITIONS: MotionCardPosition[] = ["top", "center"];

export interface MotionCard {
  id: string;
  kind: MotionCardKind;
  /** The headline: the phrase, the figure, the list's title, the quoted line. */
  text: string;
  /** A second line: what the figure counts, who is quoted, a short gloss. */
  detail: string | null;
  /** The points of a list card; empty for the other kinds. */
  items: string[];
  /** Clip-relative seconds. */
  startSec: number;
  endSec: number;
  /** Top of the frame, or its middle; never the bottom, which the captions use. */
  position: MotionCardPosition;
}

/**
 * Bounds. Shorter than MIN the card cannot be read; longer than MAX it
 * stops illustrating a moment and becomes a banner. The count keeps a clip
 * from being buried under text, and the lengths are what fits on one or
 * two lines of a vertical frame.
 */
export const MAX_MOTION_CARDS_PER_PLAN = 12;
export const MIN_MOTION_CARD_SEC = 0.8;
export const MAX_MOTION_CARD_SEC = 8;
export const MOTION_TEXT_MAX_LENGTH = 48;
export const MOTION_DETAIL_MAX_LENGTH = 64;
export const MOTION_LIST_MAX_ITEMS = 4;
export const MOTION_ITEM_MAX_LENGTH = 32;

/** Every reason a card list cannot be rendered, against a clip of `clipDurationSec`. */
export function validateMotionCards(cards: MotionCard[], clipDurationSec: number): string[] {
  const errors: string[] = [];
  if (cards.length > MAX_MOTION_CARDS_PER_PLAN) {
    errors.push(`trop de cartes de motion : ${cards.length} (maximum ${MAX_MOTION_CARDS_PER_PLAN}).`);
  }
  const ids = new Set<string>();
  for (const card of cards) {
    const at = `carte de motion "${card.id}"`;
    if (ids.has(card.id)) errors.push(`${at} : identifiant en double.`);
    ids.add(card.id);
    if (!MOTION_CARD_KINDS.includes(card.kind)) errors.push(`${at} : type inconnu ("${card.kind}").`);
    if (!MOTION_CARD_POSITIONS.includes(card.position)) errors.push(`${at} : position inconnue ("${card.position}").`);
    const duration = card.endSec - card.startSec;
    if (!Number.isFinite(card.startSec) || !Number.isFinite(card.endSec) || card.startSec < 0 || card.endSec > clipDurationSec + 1e-6) {
      errors.push(`${at} : hors du clip (${card.startSec}s–${card.endSec}s).`);
    }
    if (!(duration >= MIN_MOTION_CARD_SEC) || duration > MAX_MOTION_CARD_SEC) {
      errors.push(`${at} : durée hors bornes [${MIN_MOTION_CARD_SEC}, ${MAX_MOTION_CARD_SEC}] s.`);
    }
    if (card.text.trim().length === 0 || card.text.length > MOTION_TEXT_MAX_LENGTH) {
      errors.push(`${at} : texte vide ou trop long (maximum ${MOTION_TEXT_MAX_LENGTH} caractères).`);
    }
    if (card.detail !== null && card.detail.length > MOTION_DETAIL_MAX_LENGTH) {
      errors.push(`${at} : détail trop long (maximum ${MOTION_DETAIL_MAX_LENGTH} caractères).`);
    }
    if (card.items.length > MOTION_LIST_MAX_ITEMS || card.items.some((item) => item.length > MOTION_ITEM_MAX_LENGTH)) {
      errors.push(`${at} : liste trop longue (${MOTION_LIST_MAX_ITEMS} points de ${MOTION_ITEM_MAX_LENGTH} caractères au plus).`);
    }
  }
  // One card at a time: two cards on screen together would fight for the
  // same spot and for the viewer's attention.
  const sorted = [...cards].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startSec < sorted[i - 1].endSec - 1e-6) {
      errors.push(`les cartes "${sorted[i - 1].id}" et "${sorted[i].id}" se chevauchent.`);
    }
  }
  return errors;
}

/**
 * Cards moved with the clip's start (`offsetSec`) and kept within its new
 * length; a card that no longer fits long enough to be read is dropped.
 */
export function retimeMotionCards(cards: MotionCard[], durationSec: number, offsetSec: number): MotionCard[] {
  const kept: MotionCard[] = [];
  for (const card of cards) {
    const startSec = Math.min(Math.max(card.startSec - offsetSec, 0), durationSec);
    const endSec = Math.min(Math.max(card.endSec - offsetSec, 0), durationSec);
    if (endSec - startSec < MIN_MOTION_CARD_SEC) continue;
    kept.push({ ...card, startSec, endSec });
  }
  return kept;
}
