import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import type { FramingShot, RenderPlan } from "@/lib/effects/types";
import type { Segment } from "@/lib/domain/types";
import { FramingPanel } from "./FramingPanel";

const LEFT_RECT = { x: 0.05, y: 0, width: 0.5625, height: 1 };
const RIGHT_RECT = { x: 0.39, y: 0, width: 0.5625, height: 1 };

function shot(id: string, startSec: number, endSec: number, rect = LEFT_RECT, label = "Intervenant A"): FramingShot {
  return { id, startSec, endSec, rect, transitionSec: 0, source: "speaker", label };
}

const SHOTS: FramingShot[] = [
  shot("shot-1", 0, 20),
  shot("shot-2", 20, 40, RIGHT_RECT, "Intervenant B"),
  shot("shot-3", 40, 60),
];

function planWith(framing: FramingShot[]): RenderPlan {
  return { ...buildRenderPlan("speaker-focus", { segmentId: "seg-1", segmentDurationSec: 60 }), framing };
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

describe("FramingPanel", () => {
  it("dit ce qu'il faut pour que le cadre suive le locuteur quand il n'y a aucun plan", () => {
    render(<FramingPanel segment={segment(planWith([]))} onChange={vi.fn()} />);
    expect(screen.getByTestId("framing-empty")).toHaveTextContent(/activité labiale/i);
    expect(screen.getByTestId("framing-empty")).toHaveTextContent(/intervenants/i);
  });

  it("explique le cadrage fixe quand le clip n'a pas de plan de montage", () => {
    render(<FramingPanel segment={segment(null)} onChange={vi.fn()} />);
    expect(screen.getByTestId("framing-panel")).toHaveTextContent(/fixe du début à la fin/i);
  });

  it("liste chaque plan avec son intervenant, son origine et ses bornes", () => {
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={vi.fn()} />);
    expect(screen.getByTestId("framing-shot-shot-1")).toHaveTextContent("Intervenant A");
    expect(screen.getByTestId("framing-shot-shot-1")).toHaveTextContent("locuteur détecté");
    expect(screen.getByTestId("framing-shot-shot-2")).toHaveTextContent("20.0s → 40.0s");
  });

  it("déplace la coupe entre deux plans", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Coupe après le plan 1"), { target: { value: "12" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.framing[0].endSec).toBe(12);
    expect(plan.framing[1].startSec).toBe(12);
    expect(validateRenderPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("n'offre pas de coupe après le dernier plan", () => {
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Coupe après le plan 3")).not.toBeInTheDocument();
  });

  it("recadre un plan sur l'autre intervenant", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Cadrer le plan 1 sur"), { target: { value: "Intervenant B" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.framing[0].rect).toEqual(RIGHT_RECT);
    expect(plan.framing[0].source).toBe("manual");
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("transforme une coupe franche en panoramique", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Panoramique du plan 2"), { target: { value: "0.4" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.framing[1].transitionSec).toBe(0.4);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("supprime un plan en donnant son temps à son voisin", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    fireEvent.click(screen.getAllByText("Supprimer ce plan")[1]);

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.framing.map((s) => s.id)).toEqual(["shot-1", "shot-3"]);
    expect(plan.framing[0].endSec).toBe(40);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("revient à un cadre fixe", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    fireEvent.click(screen.getByText("Revenir à un cadre fixe"));

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.framing).toEqual([]);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("ne change rien et prévient quand le clip est en lecture seule", () => {
    const onChange = vi.fn();
    const onReadOnlyAttempt = vi.fn();
    render(
      <FramingPanel
        segment={segment(planWith(SHOTS))}
        readOnly
        onChange={onChange}
        onReadOnlyAttempt={onReadOnlyAttempt}
      />
    );

    fireEvent.click(screen.getByText("Revenir à un cadre fixe"));
    fireEvent.change(screen.getByLabelText("Coupe après le plan 1"), { target: { value: "12" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(onReadOnlyAttempt).toHaveBeenCalled();
  });

  it("ne propose pas de changer d'intervenant quand il n'y en a qu'un", () => {
    const single = [shot("shot-1", 0, 30), shot("shot-2", 30, 60)];
    render(<FramingPanel segment={segment(planWith(single))} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Cadrer le plan 1 sur")).not.toBeInTheDocument();
  });

  it("produit toujours un plan que le serveur accepterait, quel que soit le réglage poussé à fond", () => {
    const onChange = vi.fn();
    render(<FramingPanel segment={segment(planWith(SHOTS))} onChange={onChange} />);

    for (const value of ["0", "60", "35.5"]) {
      fireEvent.change(screen.getByLabelText("Coupe après le plan 1"), { target: { value } });
    }
    for (const value of ["0", "1", "0.55"]) {
      fireEvent.change(screen.getByLabelText("Panoramique du plan 2"), { target: { value } });
    }

    for (const call of onChange.mock.calls) {
      expect(validateRenderPlan(call[0] as RenderPlan)).toEqual({ ok: true, errors: [] });
    }
  });
});
