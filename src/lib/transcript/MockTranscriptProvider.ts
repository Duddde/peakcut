import type { Transcript, TranscriptWord } from "@/lib/domain/types";
import type { TranscriptProvider, TranscriptRequest } from "./TranscriptProvider";

/**
 * Deterministic, offline mock transcript provider used for demos and tests.
 * It performs no network I/O, needs no API key, and always returns the same
 * fixed demo script regardless of the actual media content — it exists to
 * exercise the rest of the pipeline (scoring, editing, export) end to end
 * without depending on a paid speech-to-text service.
 */

const DEMO_SCRIPT: Array<{ text: string; speaker: string }> = [
  { text: "3", speaker: "A" },
  { text: "secrets", speaker: "A" },
  { text: "que", speaker: "A" },
  { text: "personne", speaker: "A" },
  { text: "ne", speaker: "A" },
  { text: "te", speaker: "A" },
  { text: "dira", speaker: "A" },
  { text: "jamais", speaker: "A" },
  { text: "sur", speaker: "A" },
  { text: "le", speaker: "A" },
  { text: "montage", speaker: "A" },
  { text: "vidéo.", speaker: "A" },
  { text: "Pourquoi", speaker: "B" },
  { text: "est-ce", speaker: "B" },
  { text: "que", speaker: "B" },
  { text: "personne", speaker: "B" },
  { text: "n'en", speaker: "B" },
  { text: "parle", speaker: "B" },
  { text: "vraiment", speaker: "B" },
  { text: "?", speaker: "B" },
  { text: "J'étais", speaker: "A" },
  { text: "tellement", speaker: "A" },
  { text: "choqué", speaker: "A" },
  { text: "la", speaker: "A" },
  { text: "première", speaker: "A" },
  { text: "fois", speaker: "A" },
  { text: "que", speaker: "A" },
  { text: "j'ai", speaker: "A" },
  { text: "vu", speaker: "A" },
  { text: "le", speaker: "A" },
  { text: "résultat.", speaker: "A" },
  { text: "Voici", speaker: "A" },
  { text: "trois", speaker: "A" },
  { text: "astuces", speaker: "A" },
  { text: "essentielles", speaker: "A" },
  { text: "pour", speaker: "A" },
  { text: "progresser", speaker: "A" },
  { text: "rapidement", speaker: "A" },
  { text: "sans", speaker: "A" },
  { text: "vous", speaker: "A" },
  { text: "ruiner.", speaker: "A" },
];

const WORD_DURATION_SEC = 0.32;
const GAP_SEC = 0.05;
const BASE_CONFIDENCE = 0.92;
const CONFIDENCE_VARIATION = 0.06;

function buildWords(): TranscriptWord[] {
  let cursor = 0;
  return DEMO_SCRIPT.map((entry, index) => {
    const startSec = Number(cursor.toFixed(3));
    const endSec = Number((startSec + WORD_DURATION_SEC).toFixed(3));
    cursor = endSec + GAP_SEC;
    // Deterministic pseudo-variation derived from index, not Math.random.
    const variation = ((index * 7) % 10) / 10;
    const confidence = Number(
      Math.min(0.99, BASE_CONFIDENCE + variation * CONFIDENCE_VARIATION).toFixed(3)
    );
    return {
      text: entry.text,
      startSec,
      endSec,
      speaker: entry.speaker,
      confidence,
    };
  });
}

export class MockTranscriptProvider implements TranscriptProvider {
  readonly id = "mock-deterministic";
  readonly displayName = "Démo déterministe (hors-ligne, sans clé API)";

  async transcribe(_request: TranscriptRequest): Promise<Transcript> {
    return {
      language: "fr",
      providerId: this.id,
      words: buildWords(),
    };
  }
}
