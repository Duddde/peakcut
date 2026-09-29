import { describe, expect, it } from "vitest";
import { deriveCategories } from "./deriveCategories";
import type { ScoreBreakdown } from "@/lib/domain/types";

function breakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    hook: 0,
    lexicalDensity: 0,
    question: 0,
    emotion: 0,
    speakerChange: 0,
    duration: 0,
    penalties: 0,
    ...overrides,
  };
}

describe("deriveCategories", () => {
  it("returns no categories when every factor is below the threshold", () => {
    expect(deriveCategories(breakdown())).toEqual([]);
  });

  it("tags a strong hook", () => {
    expect(deriveCategories(breakdown({ hook: 0.8 }))).toContain("accroche");
  });

  it("tags a strong question factor", () => {
    expect(deriveCategories(breakdown({ question: 1 }))).toContain("question");
  });

  it("tags strong emotion", () => {
    expect(deriveCategories(breakdown({ emotion: 0.7 }))).toContain("émotion");
  });

  it("tags a strong speaker change", () => {
    expect(deriveCategories(breakdown({ speakerChange: 0.9 }))).toContain("dialogue");
  });

  it("tags an ideal duration", () => {
    expect(deriveCategories(breakdown({ duration: 1 }))).toContain("durée-idéale");
  });

  it("tags high lexical density", () => {
    expect(deriveCategories(breakdown({ lexicalDensity: 0.9 }))).toContain("dense");
  });

  it("can return multiple categories at once, in a stable factor order", () => {
    const cats = deriveCategories(breakdown({ hook: 0.9, question: 1, emotion: 0.6 }));
    expect(cats).toEqual(["accroche", "question", "émotion"]);
  });

  it("never derives a category from penalties", () => {
    const cats = deriveCategories(breakdown({ penalties: 0.9 }));
    expect(cats).toEqual([]);
  });

  it("does not tag a factor sitting exactly at a low, non-qualifying value", () => {
    expect(deriveCategories(breakdown({ hook: 0.1 }))).toEqual([]);
  });
});
