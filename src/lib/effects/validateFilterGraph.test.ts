import { describe, expect, it } from "vitest";
import { validateFilterGraph } from "./validateFilterGraph";

describe("validateFilterGraph", () => {
  it("accepts a typical PeakCut crop+scale+ass filtergraph", () => {
    const result = validateFilterGraph(
      "crop=w=in_w*0.3164:h=in_h:x=in_w*0.3418:y=0,scale=1080:1920,setsar=1,ass='/tmp/a.ass'"
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts a filtergraph with a piecewise if/lt zoom expression", () => {
    const result = validateFilterGraph(
      "crop=w='in_w*0.3/clip(if(lt(t,1),1+0.06*t,1.06-0.06*(t-1)),1,1.15)':h=in_h,scale=1080:1920"
    );
    expect(result.ok).toBe(true);
  });

  it("accepts bracketed filter_complex pad syntax", () => {
    const result = validateFilterGraph("[0:a]volume=1[main];[1:a]volume=0.5[bg];[main][bg]amix=inputs=2");
    expect(result.ok).toBe(true);
  });

  it("rejects an empty filtergraph", () => {
    expect(validateFilterGraph("").ok).toBe(false);
  });

  it("rejects a filtergraph longer than the maximum length", () => {
    const huge = "crop=" + "w=1,".repeat(3000);
    expect(validateFilterGraph(huge).ok).toBe(false);
  });

  it("rejects a filtergraph containing a newline", () => {
    expect(validateFilterGraph("crop=w=1:h=1\n;rm -rf /").ok).toBe(false);
  });

  it("rejects shell metacharacters even though ffmpeg is never spawned via a shell", () => {
    for (const dangerous of ["|", "&", "$(", "`", "<", ">"]) {
      expect(validateFilterGraph(`crop=w=1:h=1${dangerous}echo hi`).ok).toBe(false);
    }
  });

  it("allows ';' as a legitimate filter_complex chain separator", () => {
    expect(validateFilterGraph("crop=w=1:h=1;scale=2:2").ok).toBe(true);
  });

  it("rejects an extreme numeric literal", () => {
    expect(validateFilterGraph("crop=w=in_w*999999:h=in_h").ok).toBe(false);
  });

  it("rejects a non-finite-looking exponent value", () => {
    expect(validateFilterGraph("crop=w=1e400:h=in_h").ok).toBe(false);
  });

  it("accepts small, sane decimal and negative values", () => {
    expect(validateFilterGraph("crop=w=in_w*0.32:h=in_h*1.0:x=-0.01").ok).toBe(true);
  });

  it("collects multiple errors at once", () => {
    const result = validateFilterGraph("bad;chars`here" + "9".repeat(6) + "\n");
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
