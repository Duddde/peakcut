import { describe, expect, it } from "vitest";
import { scoreSegment } from "./scoreSegment";
import type { TranscriptWord } from "@/lib/domain/types";

function word(
  text: string,
  startSec: number,
  endSec: number,
  speaker = "A",
  confidence = 0.95
): TranscriptWord {
  return { text, startSec, endSec, speaker, confidence };
}

function wordsFromSentence(
  sentence: string,
  startAt: number,
  speaker = "A",
  confidence = 0.95
): TranscriptWord[] {
  const tokens = sentence.split(" ");
  let t = startAt;
  return tokens.map((tok) => {
    const w = word(tok, t, t + 0.3, speaker, confidence);
    t += 0.35;
    return w;
  });
}

describe("scoreSegment", () => {
  it("returns a zero score with an explanation for an empty segment", () => {
    const score = scoreSegment({ words: [], startSec: 0, endSec: 0 });
    expect(score.value).toBe(0);
    expect(score.confidence).toBe(0);
    expect(score.explanation.reasons.length + score.explanation.penaltyReasons.length).toBeGreaterThan(0);
  });

  it("never calls it watch time or viral in any explanation text", () => {
    const words = wordsFromSentence(
      "3 secrets que personne ne te dira jamais sur le succès",
      0
    );
    const score = scoreSegment({ words, startSec: 0, endSec: 25 });
    const allText = [
      ...score.explanation.reasons,
      ...score.explanation.penaltyReasons,
    ]
      .join(" ")
      .toLowerCase();
    expect(allText).not.toContain("watch time");
    expect(allText).not.toContain("viral");
  });

  it("rewards a hook with a number and a curiosity keyword in the opening words", () => {
    const hooky = wordsFromSentence(
      "3 secrets que personne ne te dira jamais sur le succès",
      0
    );
    const flat = wordsFromSentence(
      "aujourd'hui je vais vous parler de mon lundi habituel",
      0
    );
    const hookyScore = scoreSegment({ words: hooky, startSec: 0, endSec: 25 });
    const flatScore = scoreSegment({ words: flat, startSec: 0, endSec: 25 });
    expect(hookyScore.explanation.breakdown.hook).toBeGreaterThan(
      flatScore.explanation.breakdown.hook
    );
    expect(hookyScore.value).toBeGreaterThan(flatScore.value);
  });

  it("detects a question and scores it higher on the question factor", () => {
    const withQuestion = wordsFromSentence(
      "pourquoi est-ce que personne ne parle de ça ?",
      0
    );
    const withoutQuestion = wordsFromSentence(
      "je vais vous parler de ça maintenant tranquillement",
      0
    );
    const q = scoreSegment({ words: withQuestion, startSec: 0, endSec: 25 });
    const noQ = scoreSegment({ words: withoutQuestion, startSec: 0, endSec: 25 });
    expect(q.explanation.breakdown.question).toBeGreaterThan(
      noQ.explanation.breakdown.question
    );
  });

  it("detects emotional language", () => {
    const emotional = wordsFromSentence(
      "j'étais tellement choqué et incroyablement heureux ce jour-là",
      0
    );
    const neutral = wordsFromSentence(
      "j'ai ouvert la porte et posé mon sac sur la table",
      0
    );
    const e = scoreSegment({ words: emotional, startSec: 0, endSec: 25 });
    const n = scoreSegment({ words: neutral, startSec: 0, endSec: 25 });
    expect(e.explanation.breakdown.emotion).toBeGreaterThan(
      n.explanation.breakdown.emotion
    );
  });

  it("rewards speaker changes inside the segment", () => {
    const dialogue: TranscriptWord[] = [
      ...wordsFromSentence("tu ne devineras jamais ce qui est arrivé", 0, "A"),
      ...wordsFromSentence("quoi raconte tout de suite", 3, "B"),
      ...wordsFromSentence("attends laisse moi finir", 6, "A"),
    ];
    const monologue = wordsFromSentence(
      "tu ne devineras jamais ce qui est arrivé quoi raconte tout de suite attends laisse moi finir",
      0,
      "A"
    );
    const d = scoreSegment({ words: dialogue, startSec: 0, endSec: 9 });
    const m = scoreSegment({ words: monologue, startSec: 0, endSec: 9 });
    expect(d.explanation.breakdown.speakerChange).toBeGreaterThan(
      m.explanation.breakdown.speakerChange
    );
  });

  it("scores a duration near the ideal short-form range highest", () => {
    const words = wordsFromSentence(
      "voici une histoire incroyable que je dois vous raconter aujourd'hui",
      0
    );
    const ideal = scoreSegment({ words, startSec: 0, endSec: 30 });
    const tooShort = scoreSegment({ words, startSec: 0, endSec: 3 });
    const tooLong = scoreSegment({ words, startSec: 0, endSec: 180 });
    expect(ideal.explanation.breakdown.duration).toBeGreaterThan(
      tooShort.explanation.breakdown.duration
    );
    expect(ideal.explanation.breakdown.duration).toBeGreaterThan(
      tooLong.explanation.breakdown.duration
    );
  });

  it("applies a penalty and lowers confidence for low transcript confidence", () => {
    const confident = wordsFromSentence(
      "voici une histoire incroyable que je dois vous raconter",
      0,
      "A",
      0.95
    );
    const unsure = wordsFromSentence(
      "voici une histoire incroyable que je dois vous raconter",
      0,
      "A",
      0.2
    );
    const c = scoreSegment({ words: confident, startSec: 0, endSec: 25 });
    const u = scoreSegment({ words: unsure, startSec: 0, endSec: 25 });
    expect(u.explanation.breakdown.penalties).toBeGreaterThan(
      c.explanation.breakdown.penalties
    );
    expect(u.confidence).toBeLessThan(c.confidence);
    expect(u.explanation.penaltyReasons.length).toBeGreaterThan(0);
  });

  it("applies a penalty for a segment that is mostly filler words", () => {
    const filler = wordsFromSentence("euh euh du coup genre en fait euh voilà quoi", 0);
    const content = wordsFromSentence(
      "voici trois astuces essentielles pour progresser rapidement",
      0
    );
    const f = scoreSegment({ words: filler, startSec: 0, endSec: 20 });
    const c = scoreSegment({ words: content, startSec: 0, endSec: 20 });
    expect(f.explanation.breakdown.penalties).toBeGreaterThan(
      c.explanation.breakdown.penalties
    );
  });

  it("keeps the final value within [0, 100]", () => {
    const words = wordsFromSentence(
      "3 secrets choquants que personne ne te dira jamais pourquoi es-tu si incroyable",
      0
    );
    const score = scoreSegment({ words, startSec: 0, endSec: 25 });
    expect(score.value).toBeGreaterThanOrEqual(0);
    expect(score.value).toBeLessThanOrEqual(100);
  });

  it("is a pure deterministic function of its input", () => {
    const words = wordsFromSentence(
      "pourquoi personne ne parle jamais de ce secret incroyable",
      0
    );
    const a = scoreSegment({ words, startSec: 0, endSec: 25 });
    const b = scoreSegment({ words, startSec: 0, endSec: 25 });
    expect(a).toEqual(b);
  });

  it("raises confidence with more, higher-confidence words", () => {
    const short = wordsFromSentence("incroyable", 0, "A", 0.95);
    const long = wordsFromSentence(
      "voici une histoire vraiment incroyable que je dois absolument vous raconter aujourd'hui",
      0,
      "A",
      0.95
    );
    const s = scoreSegment({ words: short, startSec: 0, endSec: 5 });
    const l = scoreSegment({ words: long, startSec: 0, endSec: 25 });
    expect(l.confidence).toBeGreaterThan(s.confidence);
  });
});
