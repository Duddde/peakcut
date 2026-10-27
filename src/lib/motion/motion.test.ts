import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { compileMotionAss } from "./compileMotionAss";
import {
  ClaudeMotionDesigner,
  ClaudeMotionError,
  ClaudeMotionNotConfiguredError,
  CLAUDE_MOTION_MODEL,
  isClaudeMotionConfigured,
  sanitizeMotionCards,
  transcriptLines,
} from "./ClaudeMotionDesigner";
import { MAX_MOTION_CARD_SEC, MIN_MOTION_CARD_SEC, retimeMotionCards, validateMotionCards, type MotionCard } from "./types";
import { buildAssSubtitles } from "@/lib/ffmpeg/buildAssSubtitles";
import type { TranscriptWord } from "@/lib/domain/types";

function card(overrides: Partial<MotionCard> = {}): MotionCard {
  return { id: "m1", kind: "keyword", text: "Idée clé", detail: null, items: [], startSec: 1, endSec: 3, position: "top", ...overrides };
}

describe("validateMotionCards", () => {
  it("accepts well-formed cards and refuses overlaps, out-of-clip times and over-long text", () => {
    expect(validateMotionCards([card(), card({ id: "m2", startSec: 3, endSec: 5 })], 10)).toEqual([]);
    expect(validateMotionCards([card(), card({ id: "m2", startSec: 2, endSec: 5 })], 10).join(" ")).toMatch(/chevauchent/);
    expect(validateMotionCards([card({ endSec: 12 })], 10).join(" ")).toMatch(/hors du clip/);
    expect(validateMotionCards([card({ text: "x".repeat(80) })], 10).join(" ")).toMatch(/trop long/);
    expect(validateMotionCards([card({ endSec: 1.2 })], 10).join(" ")).toMatch(/durée/);
  });
});

describe("retimeMotionCards", () => {
  it("moves cards with the clip's start and drops those that no longer fit", () => {
    const moved = retimeMotionCards([card({ startSec: 4, endSec: 6 }), card({ id: "m2", startSec: 0, endSec: 1.5 })], 10, 2);
    expect(moved).toEqual([card({ startSec: 2, endSec: 4 })]);
  });
});

describe("compileMotionAss", () => {
  it("draws each kind as animated events in the top or middle of the frame, never at the bottom", () => {
    const ass = compileMotionAss(
      [
        card({ detail: "précision" }),
        card({ id: "m2", kind: "stat", text: "3 000 €", detail: "le prix", startSec: 4, endSec: 6, position: "center" }),
        card({ id: "m3", kind: "list", text: "Trois choses", items: ["un", "deux", "trois"], startSec: 7, endSec: 10 }),
        card({ id: "m4", kind: "quote", text: "C'est fini", detail: "Lui", startSec: 11, endSec: 13 }),
      ],
      { videoWidth: 1080, videoHeight: 1920 }
    );
    expect(ass.styles.map((s) => s.split(",")[0])).toEqual([
      "Style: MotionTitle",
      "Style: MotionQuote",
      "Style: MotionStat",
      "Style: MotionDetail",
      "Style: MotionItem",
    ]);
    // keyword + detail, stat + detail, list title + 3 items, quote + author.
    expect(ass.events).toHaveLength(10);
    expect(ass.events[0]).toMatch(/^Dialogue: 1,0:00:01\.00,0:00:03\.00,MotionTitle/);
    expect(ass.events[0]).toContain("\\t(");
    // Every card sits in the top three quarters: the bottom is the captions'.
    for (const event of ass.events) {
      const position = /\\(?:pos|move)\((\d+),(\d+)/.exec(event);
      expect(position).not.toBeNull();
      expect(Number(position![2])).toBeLessThan(1920 * 0.75);
    }
    // List points arrive one after the other.
    const delays = ass.events.filter((e) => e.includes("MotionItem")).map((e) => Number(/\\move\([^)]*,(\d+),\d+\)/.exec(e)?.[1]));
    expect(delays).toEqual([250, 600, 950]);
  });

  it("never lets a card's text carry ASS override codes", () => {
    const ass = compileMotionAss([card({ text: "{\\fs200}piège\\N" })], { videoWidth: 540, videoHeight: 960 });
    expect(ass.events[0].endsWith("fs200piègeN")).toBe(true);
  });

  it("joins the caption track, which is then worth burning in even with no word", () => {
    const content = buildAssSubtitles([], { videoWidth: 540, videoHeight: 960, motionCards: [card()] });
    expect(content).toContain("Style: MotionTitle");
    expect(content).toContain("Dialogue: 1,");
  });
});

describe("sanitizeMotionCards", () => {
  const designed = (o: Partial<Parameters<typeof sanitizeMotionCards>[0][number]> = {}) => ({
    kind: "keyword" as const,
    text: "Idée",
    detail: null,
    items: [],
    startSec: 1,
    endSec: 3,
    position: "top" as const,
    ...o,
  });

  it("always returns cards the validator accepts, whatever Claude proposed", () => {
    const cards = sanitizeMotionCards(
      [
        designed({ startSec: -2, endSec: 0.1 }),
        designed({ startSec: 2, endSec: 30, text: "Une idée formulée beaucoup trop longuement pour une carte" }),
        designed({ startSec: 4, endSec: 6 }),
        designed({ kind: "stat", text: "42", items: ["ne devrait pas rester"], startSec: 58.8, endSec: 70 }),
      ],
      60
    );
    expect(validateMotionCards(cards, 60)).toEqual([]);
    expect(cards[0].startSec).toBe(0);
    expect(cards[0].endSec - cards[0].startSec).toBeGreaterThanOrEqual(MIN_MOTION_CARD_SEC);
    expect(cards.every((c) => c.endSec - c.startSec <= MAX_MOTION_CARD_SEC)).toBe(true);
    expect(cards.find((c) => c.kind === "stat")?.items).toEqual([]);
    expect(cards.every((c) => c.text.length <= 48)).toBe(true);
  });
});

describe("transcriptLines", () => {
  it("gives Claude the clip's phrases with their clip-relative time and voice", () => {
    const words: TranscriptWord[] = [
      { text: "Bonjour", startSec: 100, endSec: 100.4, speaker: "A", confidence: 0.9 },
      { text: "tout.", startSec: 100.4, endSec: 100.8, speaker: "A", confidence: 0.9 },
      { text: "Salut", startSec: 102, endSec: 102.3, speaker: "B", confidence: 0.9 },
    ];
    expect(transcriptLines(words, 100)).toBe("[0.0s] (A) Bonjour tout.\n[2.0s] (B) Salut");
  });
});

describe("ClaudeMotionDesigner", () => {
  const words: TranscriptWord[] = [
    { text: "On", startSec: 10, endSec: 10.2, confidence: 0.9 },
    { text: "a", startSec: 10.2, endSec: 10.3, confidence: 0.9 },
    { text: "vendu", startSec: 10.3, endSec: 10.7, confidence: 0.9 },
    { text: "3000", startSec: 10.7, endSec: 11.1, confidence: 0.9 },
    { text: "places.", startSec: 11.1, endSec: 11.6, confidence: 0.9 },
  ];

  function fakeClient(response: Record<string, unknown>) {
    const parse = vi.fn(async () => response);
    return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
  }

  it("refuses to run without a Claude credential, before any request", async () => {
    expect(isClaudeMotionConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    await expect(
      new ClaudeMotionDesigner({ env: {} as NodeJS.ProcessEnv }).design({ words, clipStartSec: 10, clipEndSec: 20 })
    ).rejects.toBeInstanceOf(ClaudeMotionNotConfiguredError);
  });

  it("asks Claude for structured cards, with the server-side fallback on, and returns them cleaned", async () => {
    const { client, parse } = fakeClient({
      stop_reason: "end_turn",
      parsed_output: {
        cards: [
          { kind: "stat", text: "3 000", detail: "places vendues", items: [], startSec: 0.6, endSec: 3.5, position: "center" },
        ],
      },
    });
    const cards = await new ClaudeMotionDesigner({ client }).design({ words, clipStartSec: 10, clipEndSec: 20, title: "Ventes" });

    expect(cards).toEqual([
      { id: "motion-1", kind: "stat", text: "3 000", detail: "places vendues", items: [], startSec: 0.6, endSec: 3.5, position: "center" },
    ]);
    const request = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(request.model).toBe(CLAUDE_MOTION_MODEL);
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((request.output_config as { format?: unknown }).format).toBeTruthy();
    expect(JSON.stringify(request.messages)).toContain("[0.0s] On a vendu 3000 places.");
  });

  it("says so when the request is refused, instead of returning nothing", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", parsed_output: null });
    await expect(new ClaudeMotionDesigner({ client }).design({ words, clipStartSec: 10, clipEndSec: 20 })).rejects.toBeInstanceOf(
      ClaudeMotionError
    );
  });

  it("does not call Claude for a clip with nothing said in it", async () => {
    const { client, parse } = fakeClient({});
    expect(await new ClaudeMotionDesigner({ client }).design({ words, clipStartSec: 30, clipEndSec: 40 })).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });
});
