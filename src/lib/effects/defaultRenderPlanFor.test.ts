import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@/lib/domain/types";
import { validateRenderPlan } from "./validateRenderPlan";
import { defaultRenderPlanFor, defaultTemplateFor, speakerChangeTimesWithin } from "./defaultRenderPlanFor";

function word(text: string, startSec: number, speaker?: string): TranscriptWord {
  return { text, startSec, endSec: startSec + 0.4, speaker, confidence: 0.9 };
}

describe("speakerChangeTimesWithin", () => {
  it("reports each change, relative to the start of the clip", () => {
    const words = [word("a", 100, "A"), word("b", 101, "A"), word("c", 102, "B"), word("d", 103, "A")];
    expect(speakerChangeTimesWithin(words, 100)).toEqual([2, 3]);
  });

  it("reports nothing for a single speaker", () => {
    expect(speakerChangeTimesWithin([word("a", 0, "A"), word("b", 1, "A")], 0)).toEqual([]);
  });

  it("ignores words with no speaker rather than treating them as a change", () => {
    const words = [word("a", 0, "A"), word("b", 1), word("c", 2, "A")];
    expect(speakerChangeTimesWithin(words, 0)).toEqual([]);
  });

  it("never emits a negative time, even if a word starts before the clip", () => {
    const words = [word("a", 5, "A"), word("b", 6, "B")];
    expect(speakerChangeTimesWithin(words, 10)).toEqual([0]);
  });
});

describe("defaultTemplateFor", () => {
  it("focuses on the speaker when the clip is an exchange", () => {
    expect(defaultTemplateFor(1)).toBe("speaker-focus");
  });

  it("uses a single slow punch for a monologue", () => {
    expect(defaultTemplateFor(0)).toBe("subtle-punch");
  });
});

describe("defaultRenderPlanFor", () => {
  const monologue = [word("voici", 10, "A"), word("une", 11, "A"), word("histoire", 12, "A")];
  const dialogue = [word("voici", 10, "A"), word("quoi", 11, "B"), word("ça", 12, "A")];

  it("produces a plan that passes the same validation the export applies", () => {
    for (const words of [monologue, dialogue]) {
      const plan = defaultRenderPlanFor({ segmentId: "seg-1", startSec: 10, endSec: 70, words });
      expect(validateRenderPlan(plan).ok).toBe(true);
    }
  });

  it("actually zooms, rather than declaring a flat plan", () => {
    const plan = defaultRenderPlanFor({ segmentId: "seg-1", startSec: 10, endSec: 70, words: monologue });
    expect(plan.zoomKeyframes.some((kf) => kf.scale > 1)).toBe(true);
  });

  it("lands the speaker-focus punches on the speaker changes, in clip time", () => {
    const plan = defaultRenderPlanFor({ segmentId: "seg-1", startSec: 10, endSec: 70, words: dialogue });
    expect(plan.templateId).toBe("speaker-focus");
    expect(plan.zoomKeyframes.map((kf) => kf.tSec)).toEqual([0, 1, 2]);
  });

  it("keeps every keyframe inside the clip", () => {
    const plan = defaultRenderPlanFor({ segmentId: "seg-1", startSec: 10, endSec: 70, words: dialogue });
    for (const kf of plan.zoomKeyframes) {
      expect(kf.tSec).toBeGreaterThanOrEqual(0);
      expect(kf.tSec).toBeLessThanOrEqual(60);
    }
  });

  it("is deterministic", () => {
    const input = { segmentId: "seg-1", startSec: 10, endSec: 70, words: dialogue };
    expect(defaultRenderPlanFor(input)).toEqual(defaultRenderPlanFor(input));
  });

  it("survives an empty clip without producing an invalid plan", () => {
    const plan = defaultRenderPlanFor({ segmentId: "seg-1", startSec: 10, endSec: 10, words: [] });
    expect(validateRenderPlan(plan).ok).toBe(true);
  });
});
