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

/**
 * The crop's x, as a fraction of the width, at time t: the compiled
 * expression evaluated the way ffmpeg would, for the few functions it
 * uses. What a shot list must get right is the rectangle in force at each
 * second, whatever the text of the expression.
 */
function cropXAt(filterFragment: string, t: number): number {
  const x = /:x='in_w\*\((.+)\)':y=/.exec(filterFragment)?.[1];
  if (!x) throw new Error(`pas d'expression x dans ${filterFragment}`);
  // ffmpeg's if() is a reserved word in JavaScript: it is renamed for the evaluation.
  const js = x.replace(/(^|[^a-z_])if\(/g, "$1if_(");
  const evaluate = new Function("t", "gte", "lt", "clip", "if_", "isnan", `return ${js};`) as (
    t: number,
    gte: (a: number, b: number) => number,
    lt: (a: number, b: number) => number,
    clip: (v: number, lo: number, hi: number) => number,
    if_: (c: number, a: number, b: number) => number,
    isnan: (v: number) => number
  ) => number;
  return evaluate(
    t,
    (a, b) => (a >= b ? 1 : 0),
    (a, b) => (a < b ? 1 : 0),
    (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    (c, a, b) => (c ? a : b),
    (v) => (Number.isNaN(v) ? 1 : 0)
  );
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
    // The switch happens exactly at the second shot's start.
    expect(cropXAt(result.filterFragment, 0)).toBeCloseTo(0.05, 6);
    expect(cropXAt(result.filterFragment, 4.99)).toBeCloseTo(0.05, 6);
    expect(cropXAt(result.filterFragment, 5)).toBeCloseTo(0.39, 6);
    expect(cropXAt(result.filterFragment, 9.99)).toBeCloseTo(0.39, 6);
  });

  it("garde une largeur et une hauteur constantes quand les plans ne changent que de place", () => {
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [LEFT, RIGHT],
    });

    // Only x should carry a switch: one inside w or h would mean the crop
    // window itself changes shape mid-clip, which is a bug, not a reframe
    // — and it doubles the expression for nothing.
    const width = /w='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    const height = /h='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    const x = /x='([^']+)'/.exec(result.filterFragment)?.[1] ?? "";
    expect(width).not.toContain("gte(");
    expect(height).not.toContain("gte(");
    expect(x).toContain("gte(");
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

    // A pan is a straight line over the shot's first half-second.
    expect(cropXAt(result.filterFragment, 5)).toBeCloseTo(0.05, 6);
    expect(cropXAt(result.filterFragment, 5.25)).toBeCloseTo(0.22, 6);
    expect(cropXAt(result.filterFragment, 5.5)).toBeCloseTo(0.39, 6);
    expect(cropXAt(result.filterFragment, 8)).toBeCloseTo(0.39, 6);
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

  it("garde le même résultat sous la forme imbriquée quand les plans laissent un trou", () => {
    // Not contiguous: the compact sum of steps cannot express the gap, the
    // nested form falls back to the base crop between the two shots.
    const result = compileZoomFilter({
      baseCrop: VERTICAL_CROP,
      zoomKeyframes: [{ tSec: 0, scale: 1 }],
      framing: [shotAt("shot-1", 0, 4, 0.05), shotAt("shot-2", 6, 10, 0.39)],
    });
    expect(cropXAt(result.filterFragment, 1)).toBeCloseTo(0.05, 6);
    expect(cropXAt(result.filterFragment, 5)).toBeCloseTo(0.2188, 6);
    expect(cropXAt(result.filterFragment, 7)).toBeCloseTo(0.39, 6);
  });

  it("garde le cadrage d'un vrai clip monté : 40 plans sous un zoom « punch » à chaque changement de voix", () => {
    // What an edited show produced: a punch-in held at 1.2 between speaker
    // changes (many flat keyframes), and a shot per camera cut. Spelled
    // out branch by branch, the zoom alone pushed the crop past the
    // filtergraph limit and the whole animated crop fell back to static.
    const zoomKeyframes = [{ tSec: 0, scale: 1 }];
    for (let t = 0.35; t < 60; t += 1.5) zoomKeyframes.push({ tSec: Number(t.toFixed(3)), scale: 1.2 });
    zoomKeyframes.push({ tSec: 60, scale: 1 });
    const shots = Array.from({ length: 40 }, (_, i) => shotAt(`shot-${i + 1}`, i * 1.5, (i + 1) * 1.5, i % 2 === 0 ? 0.05 : 0.4));
    const result = compileZoomFilter({ baseCrop: VERTICAL_CROP, zoomKeyframes, framing: shots });

    expect(result.framingApplied).toBe(40);
    expect(validateFilterGraph(`${result.filterFragment},scale=1080:1920`)).toEqual({ ok: true, errors: [] });
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
