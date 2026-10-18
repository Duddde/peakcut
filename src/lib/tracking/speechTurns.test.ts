import { describe, expect, it } from "vitest";
import { speakersOf, speechTurnsFromWords, turnsWithin } from "./speechTurns";
import type { TranscriptWord } from "@/lib/domain/types";

function word(text: string, startSec: number, endSec: number, speaker?: string): TranscriptWord {
  return { text, startSec, endSec, confidence: 0.9, ...(speaker ? { speaker } : {}) };
}

describe("speechTurnsFromWords", () => {
  it("rend un tour par suite de mots du même intervenant", () => {
    const turns = speechTurnsFromWords([
      word("bonjour", 0, 0.5, "A"),
      word("à", 0.5, 0.7, "A"),
      word("tous", 0.7, 1.2, "A"),
      word("salut", 1.5, 2, "B"),
      word("merci", 3, 3.4, "A"),
    ]);

    expect(turns).toEqual([
      { speaker: "A", startSec: 0, endSec: 1.2 },
      { speaker: "B", startSec: 1.5, endSec: 2 },
      { speaker: "A", startSec: 3, endSec: 3.4 },
    ]);
  });

  it("ne rend aucun tour quand la transcription n'est pas diarisée", () => {
    expect(speechTurnsFromWords([word("un", 0, 1), word("deux", 1, 2)])).toEqual([]);
  });

  it("n'attribue pas un mot non étiqueté à l'intervenant précédent", () => {
    // Attributing it would turn the provider's uncertainty into a frame on
    // a face it never named.
    const turns = speechTurnsFromWords([word("un", 0, 1, "A"), word("deux", 1, 2), word("trois", 2, 3, "A")]);
    expect(turns).toEqual([
      { speaker: "A", startSec: 0, endSec: 1 },
      { speaker: "A", startSec: 2, endSec: 3 },
    ]);
  });

  it("remet les mots dans l'ordre avant de construire les tours", () => {
    const turns = speechTurnsFromWords([word("deux", 1, 2, "B"), word("un", 0, 1, "A")]);
    expect(turns.map((t) => t.speaker)).toEqual(["A", "B"]);
  });

  it("ignore une étiquette vide ou faite d'espaces", () => {
    expect(speechTurnsFromWords([word("un", 0, 1, "   ")])).toEqual([]);
  });
});

describe("speakersOf", () => {
  it("liste les intervenants distincts dans leur ordre d'apparition", () => {
    const turns = [
      { speaker: "B", startSec: 0, endSec: 1 },
      { speaker: "A", startSec: 1, endSec: 2 },
      { speaker: "B", startSec: 2, endSec: 3 },
    ];
    expect(speakersOf(turns)).toEqual(["B", "A"]);
  });
});

describe("turnsWithin", () => {
  const turns = [
    { speaker: "A", startSec: 0, endSec: 10 },
    { speaker: "B", startSec: 12, endSec: 20 },
    { speaker: "A", startSec: 25, endSec: 30 },
  ];

  it("rogne les tours à la fenêtre et les ramène à son origine", () => {
    expect(turnsWithin(turns, 8, 15)).toEqual([
      { speaker: "A", startSec: 0, endSec: 2 },
      { speaker: "B", startSec: 4, endSec: 7 },
    ]);
  });

  it("écarte un tour qui ne touche pas la fenêtre", () => {
    expect(turnsWithin(turns, 21, 24)).toEqual([]);
  });

  it("écarte un tour qui ne fait que toucher la borne", () => {
    expect(turnsWithin(turns, 10, 12)).toEqual([]);
  });
});
