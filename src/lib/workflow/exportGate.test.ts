import { describe, expect, it } from "vitest";
import { canExportSegment, getExportBlockReasons } from "./exportGate";
import { authorizeExport, confirmRights, createInitialWorkflow } from "./workflow";

function baseParams() {
  return {
    workflow: createInitialWorkflow(),
    hasLocalMediaFile: true,
    segmentEndSec: 10,
    sourceDurationSec: 30,
  };
}

describe("getExportBlockReasons", () => {
  it("blocks everything on a fresh workflow with a local file", () => {
    const reasons = getExportBlockReasons(baseParams());
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("blocks export when there is no local media file, even if authorized", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    const reasons = getExportBlockReasons({
      ...baseParams(),
      workflow,
      hasLocalMediaFile: false,
    });
    expect(reasons.some((r) => /média local/i.test(r))).toBe(true);
  });

  it("blocks export when the segment exceeds the source duration", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    const reasons = getExportBlockReasons({
      ...baseParams(),
      workflow,
      segmentEndSec: 45,
      sourceDurationSec: 30,
    });
    expect(reasons.some((r) => /durée/i.test(r))).toBe(true);
  });

  it("returns no reasons once rights are confirmed, export authorized, file present, and segment in range", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    const reasons = getExportBlockReasons({ ...baseParams(), workflow });
    expect(reasons).toEqual([]);
  });

  it("reports rights-not-confirmed distinctly from export-not-authorized", () => {
    const reasonsFresh = getExportBlockReasons(baseParams());
    const confirmedOnly = getExportBlockReasons({
      ...baseParams(),
      workflow: confirmRights(createInitialWorkflow(), "someone"),
    });
    expect(reasonsFresh.length).toBeGreaterThan(confirmedOnly.length);
  });
});

describe("canExportSegment", () => {
  it("mirrors getExportBlockReasons emptiness", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    expect(canExportSegment({ ...baseParams(), workflow })).toBe(true);
    expect(canExportSegment(baseParams())).toBe(false);
  });
});
