import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@/lib/domain/types";
import {
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  buildCandidates,
  segmentTranscript,
  selectNonOverlapping,
  splitIntoSentenceUnits,
  turnBoundaries,
} from "./segmentTranscript";

function word(text: string, startSec: number, endSec: number, speaker = "A", confidence = 0.95): TranscriptWord {
  return { text, startSec, endSec, speaker, confidence };
}

/**
 * Builds a transcript of `sentenceCount` sentences, each `secondsPerSentence`
 * long and ending on a period, starting at t=0.
 */
function transcript(sentenceCount: number, secondsPerSentence = 2, wordsPerSentence = 5): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  const step = secondsPerSentence / wordsPerSentence;
  for (let s = 0; s < sentenceCount; s++) {
    for (let w = 0; w < wordsPerSentence; w++) {
      const start = s * secondsPerSentence + w * step;
      const isLast = w === wordsPerSentence - 1;
      words.push(word(isLast ? `mot${s}.` : `mot${s}x${w}`, start, start + step));
    }
  }
  return words;
}

const build = {
  projectId: "p1",
  idFor: (index: number) => `seg-${index}`,
  buildSafeZones: () => [],
  buildVariants: () => [],
};

describe("splitIntoSentenceUnits", () => {
  it("groups words into units on terminal punctuation", () => {
    const words = [
      word("Bonjour", 0, 0.5),
      word("ici.", 0.5, 1),
      word("Ensuite", 1, 1.5),
      word("ceci", 1.5, 2),
      word("aussi.", 2, 2.5),
    ];
    const units = splitIntoSentenceUnits(words);
    expect(units).toHaveLength(2);
    expect(units[0].words).toHaveLength(2);
    expect(units[0].endSec).toBe(1);
    expect(units[1].startSec).toBe(1);
  });

  it("recognizes question and exclamation marks, and closing quotes after them", () => {
    const words = [word("Pourquoi", 0, 1), word("ca ?", 1, 2), word("Incroyable !»", 2, 3), word("Fin.", 3, 4)];
    expect(splitIntoSentenceUnits(words)).toHaveLength(3);
  });

  it("keeps trailing words with no terminal punctuation as a final unit", () => {
    const words = [word("Une", 0, 1), word("phrase.", 1, 2), word("sans", 2, 3), word("fin", 3, 4)];
    const units = splitIntoSentenceUnits(words);
    expect(units).toHaveLength(2);
    expect(units[1].endSec).toBe(4);
  });

  it("yields one unit per word for an unpunctuated transcript rather than nothing", () => {
    const words = [word("un", 0, 1), word("deux", 1, 2), word("trois", 2, 3)];
    expect(splitIntoSentenceUnits(words)).toHaveLength(1);
  });
});

describe("buildCandidates", () => {
  it("only emits windows inside the target duration range", () => {
    const units = splitIntoSentenceUnits(transcript(30, 2));
    const candidates = buildCandidates(units, MIN_DURATION_SEC, MAX_DURATION_SEC);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const duration = c.endSec - c.startSec;
      expect(duration).toBeGreaterThanOrEqual(MIN_DURATION_SEC);
      expect(duration).toBeLessThanOrEqual(MAX_DURATION_SEC);
    }
  });

  it("starts and ends every candidate on a sentence boundary", () => {
    const units = splitIntoSentenceUnits(transcript(30, 2));
    const starts = new Set(units.map((u) => u.startSec));
    const ends = new Set(units.map((u) => u.endSec));
    for (const c of buildCandidates(units, MIN_DURATION_SEC, MAX_DURATION_SEC)) {
      expect(starts.has(c.startSec)).toBe(true);
      expect(ends.has(c.endSec)).toBe(true);
    }
  });

  it("offers a lone over-long sentence, so no stretch of video is unreachable", () => {
    // One sentence longer than the max, which nothing shorter can cover.
    const overLong = MAX_DURATION_SEC * 2;
    const words = [word("Un", 0, overLong / 2), word("monologue.", overLong / 2, overLong)];
    const candidates = buildCandidates(splitIntoSentenceUnits(words), MIN_DURATION_SEC, MAX_DURATION_SEC);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].endSec - candidates[0].startSec).toBe(overLong);
  });

  it("emits nothing when the whole transcript is shorter than the minimum", () => {
    const units = splitIntoSentenceUnits(transcript(3, 2));
    expect(buildCandidates(units, MIN_DURATION_SEC, MAX_DURATION_SEC)).toEqual([]);
  });

  it("carries the words of every sentence it spans, in order", () => {
    const units = splitIntoSentenceUnits(transcript(60, 2));
    const candidate = buildCandidates(units, MIN_DURATION_SEC, MAX_DURATION_SEC)[0];
    expect(candidate).toBeDefined();
    expect(candidate.words[0].startSec).toBe(candidate.startSec);
    expect(candidate.words[candidate.words.length - 1].endSec).toBe(candidate.endSec);
    for (let i = 1; i < candidate.words.length; i++) {
      expect(candidate.words[i].startSec).toBeGreaterThanOrEqual(candidate.words[i - 1].startSec);
    }
  });
});

describe("selectNonOverlapping", () => {
  const candidate = (startSec: number, endSec: number, value: number) => ({
    startSec,
    endSec,
    words: [word("x", startSec, endSec)],
    score: { value, confidence: 1, explanation: { breakdown: {}, reasons: [], penaltyReasons: [] } },
  });

  it("prefers the higher score and drops anything overlapping it", () => {
    const selected = selectNonOverlapping(
      [candidate(0, 20, 40), candidate(10, 30, 90), candidate(40, 60, 50)] as never,
      8
    );
    expect(selected.map((s) => s.startSec)).toEqual([10, 40]);
  });

  it("respects the candidate cap", () => {
    const selected = selectNonOverlapping(
      [candidate(0, 10, 90), candidate(20, 30, 80), candidate(40, 50, 70)] as never,
      2
    );
    expect(selected).toHaveLength(2);
  });

  it("returns candidates in chronological order, not score order", () => {
    const selected = selectNonOverlapping(
      [candidate(100, 120, 10), candidate(0, 20, 90), candidate(50, 70, 50)] as never,
      8
    );
    expect(selected.map((s) => s.startSec)).toEqual([0, 50, 100]);
  });

  it("treats touching candidates as non-overlapping", () => {
    const selected = selectNonOverlapping([candidate(0, 20, 90), candidate(20, 40, 80)] as never, 8);
    expect(selected).toHaveLength(2);
  });
});

describe("segmentTranscript", () => {
  it("returns no segment for an empty transcript", () => {
    expect(segmentTranscript([], build)).toEqual([]);
  });

  it("produces several distinct, non-overlapping segments from a long transcript", () => {
    const segments = segmentTranscript(transcript(150, 2), build);
    expect(segments.length).toBeGreaterThan(1);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startSec).toBeGreaterThanOrEqual(segments[i - 1].endSec);
    }
  });

  it("never returns one segment spanning the whole transcript when windows fit", () => {
    const words = transcript(150, 2);
    const totalDuration = words[words.length - 1].endSec - words[0].startSec;
    for (const segment of segmentTranscript(words, build)) {
      expect(segment.endSec - segment.startSec).toBeLessThan(totalDuration);
    }
  });

  it("scores every segment with a traceable explanation", () => {
    for (const segment of segmentTranscript(transcript(150, 2), build)) {
      expect(segment.score).not.toBeNull();
      expect(segment.score?.explanation.breakdown).toBeDefined();
    }
  });

  it("falls back to a single whole-transcript segment when nothing fits the range", () => {
    const segments = segmentTranscript(transcript(3, 2), build);
    expect(segments).toHaveLength(1);
    expect(segments[0].startSec).toBe(0);
  });

  it("honours the candidate cap", () => {
    expect(segmentTranscript(transcript(300, 2), build, { maxCandidates: 3 })).toHaveLength(3);
  });

  it("is deterministic: the same transcript yields the same segments", () => {
    const words = transcript(150, 2);
    const a = segmentTranscript(words, build);
    const b = segmentTranscript(words, build);
    expect(a.map((s) => [s.startSec, s.endSec])).toEqual(b.map((s) => [s.startSec, s.endSec]));
  });

  it("titles each segment from its own opening words", () => {
    const segments = segmentTranscript(transcript(150, 2), build);
    for (const segment of segments) {
      expect(segment.title).toContain(segment.words[0].text);
    }
  });

  it("builds safe zones and variants through the injected builders", () => {
    const segments = segmentTranscript(transcript(60, 2), {
      ...build,
      buildSafeZones: (id) => [{ id: `${id}-sz`, purpose: "subtitle-area", rect: { x: 0, y: 0, width: 1, height: 1 }, label: "l" }],
      buildVariants: (id) => [{ id: `${id}-v`, label: "9:16", aspectRatio: "9:16", crop: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expect(segments[0].safeZones[0].id).toBe("seg-0-sz");
    expect(segments[0].variants[0].id).toBe("seg-0-v");
  });
});

describe("turnBoundaries", () => {
  it("does not end a turn on another voice's backchannel when the speaker goes on", () => {
    // A: "c'est flop par exemple." — B: "Ouais." — A: "Dalton c'est flop."
    const words = [
      word("flop", 0, 0.3, "A"),
      word("exemple.", 0.3, 0.8, "A"),
      word("Ouais.", 0.8, 1.0, "B"),
      word("Dalton", 1.0, 1.4, "A"),
      word("flop.", 1.4, 1.8, "A"),
    ];
    const { canEndAfter, canStartAt } = turnBoundaries(words);
    expect(canEndAfter[1]).toBe(false);
    expect(canEndAfter[2]).toBe(false);
    expect(canStartAt[3]).toBe(false);
    expect(canEndAfter[4]).toBe(true);
  });

  it("ends a turn where another voice takes over for real", () => {
    const words = [
      word("question", 0, 0.5, "A"),
      word("?", 0.5, 0.6, "A"),
      word("Alors", 0.6, 1.0, "B"),
      word("voilà", 1.0, 1.4, "B"),
      word("ce", 1.4, 1.6, "B"),
      word("que", 1.6, 1.8, "B"),
      word("je", 1.8, 2.0, "B"),
    ];
    const { canEndAfter, canStartAt } = turnBoundaries(words);
    expect(canEndAfter[1]).toBe(true);
    expect(canStartAt[2]).toBe(true);
  });

  it("ends a turn on a pause, even in an undiarized transcript", () => {
    const words = [
      { text: "Fin.", startSec: 0, endSec: 0.4, confidence: 0.9 },
      { text: "Suite", startSec: 1.2, endSec: 1.5, confidence: 0.9 },
      { text: "directe.", startSec: 1.5, endSec: 1.9, confidence: 0.9 },
    ];
    const { canEndAfter } = turnBoundaries(words);
    expect(canEndAfter[0]).toBe(true);
    expect(canEndAfter[1]).toBe(false);
  });
});

describe("segmentTranscript on turns", () => {
  it("never ends a clip on a sentence its speaker carries on after", () => {
    // 40 sentences of A, 2 s each, with a backchannel from B after every
    // fifth one; A only really stops (pause) after sentence 34.
    const words: TranscriptWord[] = [];
    let t = 0;
    for (let s = 0; s < 40; s++) {
      for (let w = 0; w < 5; w++) {
        words.push(word(w === 4 ? `phrase${s}.` : `mot${s}x${w}`, t, t + 0.4, "A"));
        t += 0.4;
      }
      if (s % 5 === 4 && s < 39) {
        words.push(word("Ouais.", t, t + 0.3, "B"));
        t += 0.3;
      }
      if (s === 34) t += 1;
    }
    const segments = segmentTranscript(words, build);
    expect(segments.length).toBeGreaterThan(0);
    // Every clip ends where nobody picks up straight away (the pause after
    // sentence 34 and its "ouais"), or at the end of the transcript.
    for (const segment of segments) {
      const last = words.indexOf(segment.words[segment.words.length - 1]);
      const next = words[last + 1];
      expect(next === undefined || next.startSec - words[last].endSec >= 0.6).toBe(true);
    }
  });
});
