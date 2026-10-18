import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import {
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  type PerspectiveMove,
  type RenderPlan,
} from "@/lib/effects/types";
import type { Segment } from "@/lib/domain/types";
import { PerspectivePanel } from "./PerspectivePanel";

function move(partial: Partial<PerspectiveMove> = {}): PerspectiveMove {
  return {
    id: "m3d-1",
    startSec: 5,
    endSec: 7,
    direction: "left",
    profile: "swing",
    amount: 0.5,
    ...partial,
  };
}

function planWith(perspectiveMoves: PerspectiveMove[]): RenderPlan {
  return {
    ...buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 }),
    perspectiveMoves,
  };
}

function segment(renderPlan: RenderPlan | null): Segment {
  return {
    id: "seg-1",
    projectId: "p1",
    title: "Clip",
    startSec: 10,
    endSec: 70,
    words: [],
    score: null,
    safeZones: [],
    variants: [],
    renderPlan,
  };
}

/** Whatever the panel emits must be a plan the server would accept on save. */
function expectValid(plan: RenderPlan) {
  expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
}

describe("PerspectivePanel", () => {
  it("explique ce que l'effet fait, et ce qu'il ne fait pas", () => {
    render(<PerspectivePanel segment={segment(planWith([]))} onChange={vi.fn()} />);
    const panel = screen.getByTestId("perspective-panel");
    expect(panel).toHaveTextContent(/perspective/i);
    expect(panel).toHaveTextContent(/pas de profondeur/i);
  });

  it("dit que l'image reste plate quand le clip n'a aucun mouvement", () => {
    render(<PerspectivePanel segment={segment(planWith([]))} onChange={vi.fn()} />);
    expect(screen.getByTestId("perspective-empty")).toHaveTextContent(/reste plate/i);
  });

  it("explique le cas d'un clip sans plan de montage", () => {
    render(<PerspectivePanel segment={segment(null)} onChange={vi.fn()} />);
    expect(screen.getByTestId("perspective-panel")).toHaveTextContent(/plate du début à la fin/i);
  });

  it("liste chaque mouvement avec ses bornes", () => {
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={vi.fn()} />);
    expect(screen.getByTestId("perspective-move-m3d-1")).toHaveTextContent("5.0s → 7.0s");
  });

  it("ajoute un atterrissage en un clic, et le plan reste valide", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([]))} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Atterrissage au début/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves).toHaveLength(1);
    expect(plan.perspectiveMoves[0]).toMatchObject({ startSec: 0, profile: "settle" });
    expectValid(plan);
  });

  it("place le balancement au milieu du clip", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([]))} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Balancement au milieu/i }));
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves[0].startSec).toBeGreaterThan(20);
    expect(plan.perspectiveMoves[0].endSec).toBeLessThan(40);
    expectValid(plan);
  });

  it("change le sens d'un mouvement", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Sens du mouvement 1/i), { target: { value: "up" } });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves[0].direction).toBe("up");
    expectValid(plan);
  });

  it("change le profil d'un mouvement", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Profil du mouvement 1/i), { target: { value: "lift" } });
    expect((onChange.mock.calls[0][0] as RenderPlan).perspectiveMoves[0].profile).toBe("lift");
  });

  it("règle l'intensité sans jamais sortir des bornes", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Intensité du mouvement 1/i), { target: { value: "1" } });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves[0].amount).toBe(1);
    expectValid(plan);
  });

  it("déplace un mouvement dans le clip", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Début du mouvement 1/i), { target: { value: "30" } });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves[0].startSec).toBe(30);
    expect(plan.perspectiveMoves[0].endSec).toBe(32);
    expectValid(plan);
  });

  it("allonge un mouvement sans dépasser le clip", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Durée du mouvement 1/i), { target: { value: "60" } });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.perspectiveMoves[0].endSec).toBeLessThanOrEqual(60);
    expectValid(plan);
  });

  it("supprime un mouvement", () => {
    const onChange = vi.fn();
    render(<PerspectivePanel segment={segment(planWith([move()]))} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Supprimer ce mouvement/i }));
    expect((onChange.mock.calls[0][0] as RenderPlan).perspectiveMoves).toEqual([]);
  });

  it("revient à une image plate", () => {
    const onChange = vi.fn();
    render(
      <PerspectivePanel
        segment={segment(planWith([move(), move({ id: "m3d-2", direction: "up" })]))}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Revenir à une image plate/i }));
    expect((onChange.mock.calls[0][0] as RenderPlan).perspectiveMoves).toEqual([]);
  });

  it("dit pourquoi il refuse d'en ajouter davantage au plafond", () => {
    const moves = Array.from({ length: MAX_PERSPECTIVE_MOVES_PER_PLAN }, (_, i) =>
      move({ id: `m3d-${i}`, startSec: i * 3, endSec: i * 3 + 1 })
    );
    render(<PerspectivePanel segment={segment(planWith(moves))} onChange={vi.fn()} />);
    expect(screen.getByTestId("perspective-cap")).toHaveTextContent(/trop long pour être rendu/i);
    expect(screen.getByRole("button", { name: /Atterrissage au début/i })).toBeDisabled();
  });

  it("ne modifie rien en lecture seule et le signale", () => {
    const onChange = vi.fn();
    const onReadOnlyAttempt = vi.fn();
    render(
      <PerspectivePanel
        segment={segment(planWith([move()]))}
        readOnly
        onChange={onChange}
        onReadOnlyAttempt={onReadOnlyAttempt}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Supprimer ce mouvement/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onReadOnlyAttempt).toHaveBeenCalledTimes(1);
  });
});
