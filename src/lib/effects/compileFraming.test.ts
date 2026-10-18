import { describe, expect, it } from "vitest";
import { compileZoomFilter } from "./compileZoomFilter";
import { validateFilterGraph } from "./validateFilterGraph";
import type { NormalizedRect } from "@/lib/domain/types";
import { MAX_FRAMING_SHOTS_PER_PLAN, type FramingShot } from "./types";

/**
 * The framing half of compileZoomFilter: a crop that moves from one face
 * to another during the clip. Kept in its own file because what matters
 * here is different from what matters about the zoom — not the curve, but
 * which rectangle is in force at a given second, and whether the compiled
 * expression is one ffmpeg will actually accept.
 */

const VERTICAL_CROP: NormalizedRect = { x: 0.2188, y: 0, width: 0.5625, height: 1 };

function shotAt(id: string, startSec: number, endSec: number, x: number, overrides: Partial<FramingShot> = {}): FramingShot {
  return {
    id,
    startSec,
    endSec,
    rect: { x, y: 0, width: 0.5625, height: 1 },
    transitionSec: 0,
    source: "speaker",
    label: "Intervenant A",
    ...overrides,
  };
}

const LEFT = shotAt("shot-1", 0, 5, 0.05);
const RIGHT = shotAt("shot-2", 5, 10, 0.39);

describe("compileZoomFilter — cadrage par plans", () => {
  it("laisse le fragment inchangé quand il n'y a aucun plan de cadrage", () => {
    const withoutFraming = compileZoomFilter({ baseCrop: VERTICAL_CROP, zoomKeyframes: [] });
    const withEmptyFraming = compileZoomFilter({ baseCrop: VERTICAL_CROP, zoomKeyframes: [], framing: [] });
    expect(withEmptyFraming).toEqual(withoutFraming);
    expect(withoutFraming.framingApplied).toBe(0);
  });

  it("compile deux plans en une expression qui bascule au bon instant", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    });

    expect(result.framingApplied).toBe(2);
    expect(result.notes.filter((n) => /ignoré/.test(n))).toHaveLength(0);
    // The switch happens at the first shot's end, and both rectangles are in there.
    expect(result.filterFragment).toContain("lt(t,5.000)");
    expect(result.filterFragment).toContain("0.050000");
    expect(result.filterFragment).toContain("0.390000");
  });

  it("garde une largeur et une hauteur constantes quand les plans ne changent que de place", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    });

    // Only x should carry a branch: a condition inside w or h would mean
    // the crop window itself changes shape mid-clip, which is a bug, not
    // a reframe — and it doubles the expression for nothing.
    const width = /w='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    const height = /h='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    const x = /x='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    expect(width).not.toContain("if(");
    expect(height).not.toContain("if(");
    expect(x).toContain("if(");
  });

  it("n'encadre pas le premier plan d'une borne basse ni le dernier d'une borne haute", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    });

    // The clip's real end is a rounded number of frames: a last shot that
    // stopped at its nominal end would show the base crop for the final
    // frames.
    expect(result.filterFragment).not.toContain("gte(t,0.000)");
    expect(result.filterFragment).not.toContain("lt(t,10.000)");
  });

  it("interpole la position quand le plan demande un panoramique", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, shotAt("shot-2", 5, 10, 0.39, { transitionSec: 0.5 })],
    });

    // A pan is an expression of t inside the shot's first half-second.
    expect(result.filterFragment).toContain("lt(t,5.500)");
    expect(result.filterFragment).toContain("(t-5.000)");
  });

  it("coupe franchement quand la transition vaut 0", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    });
    expect(result.filterFragment).not.toContain("(t-5.000)");
  });

  it("applique le cadrage et le zoom dans le même filtre crop", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 5, scale: 1.2 },
      ],
      framing: [LEFT, RIGHT],
    });

    expect(result.zoomApplied).toBe(true);
    expect(result.framingApplied).toBe(2);
    expect(result.filterFragment.match(/crop=/g)).toHaveLength(1);
    expect(result.filterFragment).toContain("clip(");
  });

  it("abandonne tout le cadrage, et le dit, quand deux plans se chevauchent", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, shotAt("shot-2", 4, 10, 0.39)],
    });

    expect(result.framingApplied).toBe(0);
    expect(result.notes.some((n) => /chevauchent/.test(n))).toBe(true);
    expect(result.filterFragment).not.toContain("if(");
  });

  it("refuse une fenêtre qui sort du cadre source", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, shotAt("shot-2", 5, 10, 0.8)],
    });

    expect(result.framingApplied).toBe(0);
    expect(result.notes.some((n) => /hors du cadre source/.test(n))).toBe(true);
  });

  it("refuse une transition plus longue que le plan qu'elle ouvre", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, shotAt("shot-2", 5, 10, 0.39, { transitionSec: 6 })],
    });

    expect(result.framingApplied).toBe(0);
    expect(result.notes.some((n) => /transition invalide/.test(n))).toBe(true);
  });

  it("refuse une valeur non finie plutôt que de la compiler", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, shotAt("shot-2", 5, 10, Number.NaN)],
    });

    expect(result.framingApplied).toBe(0);
    expect(result.filterFragment).not.toContain("NaN");
  });

  it("refuse plus de plans que la borne du modèle", () => {
    const tooMany = Array.from({ length: MAX_FRAMING_SHOTS_PER_PLAN + 1 }, (_, i) =>
      shotAt(`shot-${i + 1}`, i * 2, i * 2 + 2, i % 2 === 0 ? 0.05 : 0.39)
    );
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: tooMany,
    });

    expect(result.framingApplied).toBe(0);
    expect(result.notes.some((n) => /maximum/.test(n))).toBe(true);
  });

  it("produit un filtergraph accepté par la validation indépendante dans le pire cas réaliste", () => {
    // The cap's worth of shots, each a pan to the other speaker, over an
    // animated zoom: this is what a fast two-person exchange compiles to,
    // and it is the case that would quietly fall back to a static crop if
    // the expression grew past the validator's length limit.
    const shots = Array.from({ length: MAX_FRAMING_SHOTS_PER_PLAN }, (_, i) =>
      shotAt(`shot-${i + 1}`, i * 4, i * 4 + 4, i % 2 === 0 ? 0.0513 : 0.3914, { transitionSec: 0.25 })
    );
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [
        { tSec: 0, scale: 1 },
        { tSec: 32, scale: 1.2 },
        { tSec: 64, scale: 1 },
      ],
      framing: shots,
    });

    expect(result.framingApplied).toBe(MAX_FRAMING_SHOTS_PER_PLAN);
    const graph = `${result.filterFragment},scale=1080:1920`;
    expect(validateFilterGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  it("est déterministe et indépendant de l'ordre des plans fournis", () => {
    const params = {
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    };
    const reversed = { ...params, framing: [RIGHT, LEFT] };
    expect(compileZoomFilter(params)).toEqual(compileZoomFilter(params));
    expect(compileZoomFilter(reversed).filterFragment).toBe(compileZoomFilter(params).filterFragment);
  });
});
