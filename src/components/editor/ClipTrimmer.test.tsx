import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClipTrimmer, snapToBoundary, stepBoundary, wordBoundaries } from "./ClipTrimmer";
import type { Segment, TranscriptWord } from "@/lib/domain/types";

const WORDS: TranscriptWord[] = [
  { text: "Bonjour", startSec: 10, endSec: 10.4, speaker: "A", confidence: 0.9 },
  { text: "à", startSec: 10.5, endSec: 10.6, speaker: "A", confidence: 0.9 },
  { text: "tous.", startSec: 10.6, endSec: 11, speaker: "A", confidence: 0.9 },
  { text: "Merci.", startSec: 20, endSec: 20.5, speaker: "B", confidence: 0.9 },
  { text: "Suite", startSec: 21.2, endSec: 21.6, speaker: "B", confidence: 0.9 },
];

const SEGMENT: Segment = {
  id: "seg-1",
  projectId: "p1",
  title: "Clip",
  startSec: 10,
  endSec: 20.5,
  words: WORDS.slice(0, 4),
  score: null,
  safeZones: [],
  variants: [],
  renderPlan: null,
};

describe("ClipTrimmer helpers", () => {
  it("snaps a start onto word starts and an end onto word ends, only when close", () => {
    expect(snapToBoundary(10.45, wordBoundaries(WORDS, "start"))).toBe(10.5);
    expect(snapToBoundary(20.6, wordBoundaries(WORDS, "end"))).toBe(20.5);
    expect(snapToBoundary(15, wordBoundaries(WORDS, "end"))).toBe(15);
  });

  it("steps from boundary to boundary, and stops at the last one", () => {
    const ends = wordBoundaries(WORDS, "end");
    expect(stepBoundary(20.5, ends, 1)).toBe(21.6);
    expect(stepBoundary(20.5, ends, -1)).toBe(11);
    expect(stepBoundary(21.6, ends, 1)).toBeNull();
  });
});

describe("ClipTrimmer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extends the end by one word, onto a word the clip does not have yet", () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    const onRetime = vi.fn();
    render(<ClipTrimmer segment={SEGMENT} words={WORDS} totalDurationSec={60} projectId="p1" onRetime={onRetime} />);

    expect(screen.getByText(/finit sur « Merci. »/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "mot →" })[1]);
    expect(onRetime).toHaveBeenCalledWith("seg-1", { startSec: 10, endSec: 21.6 });
  });

  it("moves an edge with the keyboard, word by word", () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    const onRetime = vi.fn();
    render(<ClipTrimmer segment={SEGMENT} words={WORDS} totalDurationSec={60} projectId="p1" onRetime={onRetime} />);

    fireEvent.keyDown(screen.getByRole("slider", { name: "Début du clip" }), { key: "ArrowRight" });
    expect(onRetime).toHaveBeenCalledWith("seg-1", { startSec: 10.5, endSec: 20.5 });
  });

  it("asks for the waveform of the project's own audio around each edge", () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<ClipTrimmer segment={SEGMENT} words={WORDS} totalDurationSec={60} projectId="p1" onRetime={vi.fn()} />);

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.every((url) => url.startsWith("/api/projects/p1/waveform?"))).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it("only shows the cuts on the read-only demo", () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    render(<ClipTrimmer segment={SEGMENT} words={WORDS} totalDurationSec={60} readOnly onRetime={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "mot →" })).not.toBeInTheDocument();
  });
});
