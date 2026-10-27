import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MotionPanel } from "./MotionPanel";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import type { Segment } from "@/lib/domain/types";
import type { MotionCard } from "@/lib/motion/types";

const CARD: MotionCard = { id: "m1", kind: "stat", text: "3 000 €", detail: "le prix", items: [], startSec: 2, endSec: 5, position: "center" };

function segment(cards: MotionCard[]): Segment {
  const plan = buildRenderPlan("speaker-focus", { segmentId: "s1", segmentDurationSec: 30 });
  return {
    id: "s1",
    projectId: "p1",
    title: "Clip",
    startSec: 100,
    endSec: 130,
    words: [],
    score: null,
    safeZones: [],
    variants: [],
    renderPlan: { ...plan, motion: cards },
  };
}

const noop = () => undefined;

describe("MotionPanel", () => {
  it("says how to turn Claude Motion on when it is not configured, and does not offer to generate", () => {
    render(<MotionPanel segment={segment([])} configured={false} generating={false} message={null} onGenerate={noop} onChange={noop} />);
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer avec claude/i })).toBeDisabled();
  });

  it("asks Claude for the clip's cards", () => {
    const onGenerate = vi.fn();
    render(<MotionPanel segment={segment([])} configured generating={false} message={null} onGenerate={onGenerate} onChange={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /générer avec claude/i }));
    expect(onGenerate).toHaveBeenCalled();
  });

  it("edits a card's wording and keeps its timing inside the clip", () => {
    const onChange = vi.fn();
    render(<MotionPanel segment={segment([CARD])} configured generating={false} message={null} onGenerate={noop} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    fireEvent.change(screen.getByLabelText("Texte"), { target: { value: "4 000 €" } });
    expect(onChange.mock.calls[0][0].motion[0]).toMatchObject({ text: "4 000 €", startSec: 2, endSec: 5 });

    fireEvent.change(screen.getByLabelText("Fin (s)"), { target: { value: "99" } });
    const end = onChange.mock.calls[1][0].motion[0].endSec;
    expect(end).toBeLessThanOrEqual(30);
  });

  it("removes a card", () => {
    const onChange = vi.fn();
    render(<MotionPanel segment={segment([CARD])} configured generating={false} message={null} onGenerate={noop} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /supprimer la carte/i }));
    expect(onChange.mock.calls[0][0].motion).toEqual([]);
  });
});
