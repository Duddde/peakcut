import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { RenderPlan } from "@/lib/effects/types";
import { ZOOM_SCALE_MAX } from "@/lib/effects/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import type { Segment } from "@/lib/domain/types";
import { EffectsPanel, peakZoomPercent, withZoomStrength } from "./EffectsPanel";

function segment(renderPlan: RenderPlan | null): Segment {
  return {
    id: "seg-1",
    projectId: "p1",
    title: "Clip",
    startSec: 10,
    endSec: 70,
    words: [
      { text: "bonjour", startSec: 10, endSec: 10.4, speaker: "A", confidence: 0.9 },
      { text: "salut", startSec: 11, endSec: 11.4, speaker: "B", confidence: 0.9 },
    ],
    score: null,
    safeZones: [],
    variants: [],
    renderPlan,
  };
}

const PLAN = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 });

describe("withZoomStrength", () => {
  it("flattens every keyframe at strength 0", () => {
    expect(withZoomStrength(PLAN, 0).zoomKeyframes.every((kf) => kf.scale === 1)).toBe(true);
  });

  it("restores the template's own amplitude at strength 1", () => {
    expect(withZoomStrength(PLAN, 1).zoomKeyframes).toEqual(PLAN.zoomKeyframes);
  });

  it("stays inside the declared bounds for any strength, including out-of-range ones", () => {
    for (const strength of [-5, 0, 0.5, 1, 99]) {
      const plan = withZoomStrength(PLAN, strength);
      expect(validateRenderPlan(plan).ok).toBe(true);
      for (const kf of plan.zoomKeyframes) {
        expect(kf.scale).toBeGreaterThanOrEqual(1);
        expect(kf.scale).toBeLessThanOrEqual(ZOOM_SCALE_MAX);
      }
    }
  });
});

describe("peakZoomPercent", () => {
  it("reports the strongest zoom as a percentage above the base framing", () => {
    expect(peakZoomPercent(buildRenderPlan("clean-captions", { segmentId: "s", segmentDurationSec: 60 }))).toBe(0);
    expect(peakZoomPercent(PLAN)).toBeGreaterThan(0);
  });
});

describe("EffectsPanel", () => {
  it("says plainly when a clip has no effects yet", () => {
    render(<EffectsPanel segment={segment(null)} onChange={() => {}} />);
    expect(screen.getByText(/n'a pas encore d'effets/i)).toBeInTheDocument();
  });

  it("builds a valid plan when a template is picked", () => {
    const onChange = vi.fn();
    render(<EffectsPanel segment={segment(null)} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/modèle d'effet/i), { target: { value: "hook-emphasis" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.templateId).toBe("hook-emphasis");
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  /**
   * The template is rebuilt from the clip's own words, so the punches of
   * "speaker-focus" land where the speaker actually changes rather than
   * on a generic curve.
   */
  it("lands speaker-focus keyframes on the clip's own speaker changes", () => {
    const onChange = vi.fn();
    render(<EffectsPanel segment={segment(null)} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/modèle d'effet/i), { target: { value: "speaker-focus" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.zoomKeyframes.map((kf) => kf.tSec)).toEqual([0, 1]);
  });

  it("keeps the caption colour the user picked", () => {
    const onChange = vi.fn();
    render(<EffectsPanel segment={segment(PLAN)} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/couleur des sous-titres/i), { target: { value: "#ff0066" } });

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.subtitleStyle.primaryColorHex).toBe("#FF0066");
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("produces a valid plan at every position of the zoom slider", () => {
    const onChange = vi.fn();
    render(<EffectsPanel segment={segment(PLAN)} onChange={onChange} />);
    const slider = screen.getByLabelText(/force du zoom/i);

    for (const value of ["0", "50", "100"]) {
      fireEvent.change(slider, { target: { value } });
    }

    expect(onChange).toHaveBeenCalledTimes(3);
    for (const [plan] of onChange.mock.calls) {
      expect(validateRenderPlan(plan as RenderPlan).ok).toBe(true);
    }
    expect(peakZoomPercent(onChange.mock.calls[0][0] as RenderPlan)).toBe(0);
  });

  it("changes nothing in read-only mode and asks for an account instead", () => {
    const onChange = vi.fn();
    const onReadOnlyAttempt = vi.fn();
    render(
      <EffectsPanel segment={segment(PLAN)} readOnly onChange={onChange} onReadOnlyAttempt={onReadOnlyAttempt} />
    );

    fireEvent.change(screen.getByLabelText(/modèle d'effet/i), { target: { value: "hook-emphasis" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(onReadOnlyAttempt).toHaveBeenCalled();
  });

  it("shows what the export still does not do", () => {
    render(<EffectsPanel segment={segment(PLAN)} onChange={() => {}} />);
    for (const limitation of PLAN.limitations) {
      expect(screen.getByText(`· ${limitation}`)).toBeInTheDocument();
    }
  });
});
