import { describe, expect, it } from "vitest";
import type { Segment, Transcript, TranscriptWord } from "@/lib/domain/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import { retimeSegment, splitSegment, wordsWithin } from "./retimeSegment";

function words(count: number, from = 0): TranscriptWord[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `mot${i}.`,
    startSec: from + i,
    endSec: from + i + 0.8,
    speaker: i % 7 === 0 ? "B" : "A",
    confidence: 0.9,
  }));
}

const TRANSCRIPT: Transcript = { language: "fr", providerId: "test", words: words(120) };

function segment(startSec: number, endSec: number): Segment {
  return {
    id: "seg-1",
    projectId: "p1",
    title: "Clip",
    startSec,
    endSec,
    words: wordsWithin(TRANSCRIPT.words, startSec, endSec),
    score: null,
    safeZones: [],
    variants: [],
    renderPlan: buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: endSec - startSec }),
  };
}

describe("wordsWithin", () => {
  it("keeps the words that start inside the window, and only those", () => {
    const kept = wordsWithin(TRANSCRIPT.words, 10, 15);
    expect(kept.map((w) => w.startSec)).toEqual([10, 11, 12, 13, 14]);
  });

  it("returns nothing for an empty window", () => {
    expect(wordsWithin(TRANSCRIPT.words, 10, 10)).toEqual([]);
  });
});

describe("retimeSegment", () => {
  it("re-slices the burned-in words when the clip is trimmed", () => {
    const trimmed = retimeSegment(segment(0, 60), { startSec: 10, endSec: 40, transcript: TRANSCRIPT });
    expect(trimmed.words[0].startSec).toBe(10);
    expect(trimmed.words[trimmed.words.length - 1].startSec).toBe(39);
  });

  it("brings back words when the clip is extended, reading the project transcript", () => {
    const extended = retimeSegment(segment(10, 40), { startSec: 0, endSec: 60, transcript: TRANSCRIPT });
    expect(extended.words[0].startSec).toBe(0);
    expect(extended.words.length).toBe(60);
  });

  it("rescores the clip for its new bounds", () => {
    const retimed = retimeSegment(segment(0, 60), { startSec: 0, endSec: 5, transcript: TRANSCRIPT });
    expect(retimed.score).not.toBeNull();
    // 5s is far below the short-form plateau, so the duration factor drops.
    expect(retimed.score!.explanation.breakdown.duration).toBeLessThan(1);
  });

  it("keeps the render plan valid after a trim, instead of leaving an unsavable clip", () => {
    const trimmed = retimeSegment(segment(0, 90), { startSec: 0, endSec: 20, transcript: TRANSCRIPT });
    expect(validateRenderPlan(trimmed.renderPlan!).ok).toBe(true);
    expect(trimmed.renderPlan!.cuts).toEqual([{ startSec: 0, endSec: 20 }]);
    for (const kf of trimmed.renderPlan!.zoomKeyframes) {
      expect(kf.tSec).toBeLessThanOrEqual(20);
    }
  });

  it("leaves a clip without a plan without one", () => {
    const base = { ...segment(0, 60), renderPlan: null };
    expect(retimeSegment(base, { startSec: 0, endSec: 30, transcript: TRANSCRIPT }).renderPlan).toBeNull();
  });

  it("falls back to the segment's own words when the project has no transcript", () => {
    const retimed = retimeSegment(segment(0, 60), { startSec: 0, endSec: 30 });
    expect(retimed.words.every((w) => w.startSec < 30)).toBe(true);
  });

  it("never produces inverted bounds", () => {
    const retimed = retimeSegment(segment(0, 60), { startSec: 40, endSec: 10, transcript: TRANSCRIPT });
    expect(retimed.startSec).toBeLessThanOrEqual(retimed.endSec);
  });
});

describe("splitSegment", () => {
  const idFor = (half: "left" | "right") => `seg-${half}`;

  it("cuts a clip in two at the given point, each side keeping its own words", () => {
    const pair = splitSegment(segment(0, 60), 30, { transcript: TRANSCRIPT, idFor });
    expect(pair).not.toBeNull();
    const [left, right] = pair!;
    expect([left.startSec, left.endSec]).toEqual([0, 30]);
    expect([right.startSec, right.endSec]).toEqual([30, 60]);
    expect(left.words.every((w) => w.startSec < 30)).toBe(true);
    expect(right.words.every((w) => w.startSec >= 30)).toBe(true);
  });

  it("gives each half its own id and a valid plan", () => {
    const [left, right] = splitSegment(segment(0, 60), 30, { transcript: TRANSCRIPT, idFor })!;
    expect(left.id).toBe("seg-left");
    expect(right.id).toBe("seg-right");
    expect(validateRenderPlan(left.renderPlan!).ok).toBe(true);
    expect(validateRenderPlan(right.renderPlan!).ok).toBe(true);
  });

  it("refuses a cut that would leave a sliver, rather than making an unusable clip", () => {
    expect(splitSegment(segment(0, 60), 0.2, { transcript: TRANSCRIPT, idFor })).toBeNull();
    expect(splitSegment(segment(0, 60), 59.9, { transcript: TRANSCRIPT, idFor })).toBeNull();
  });

  it("refuses a cut outside the clip", () => {
    expect(splitSegment(segment(10, 60), 5, { transcript: TRANSCRIPT, idFor })).toBeNull();
    expect(splitSegment(segment(10, 60), 90, { transcript: TRANSCRIPT, idFor })).toBeNull();
  });
});
