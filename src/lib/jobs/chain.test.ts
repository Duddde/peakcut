import { describe, expect, it } from "vitest";
import {
  AUTO_PIPELINE_ORDER,
  CHAIN_PAYLOAD_KEY,
  ChainConfigurationError,
  attachChain,
  buildAutoPipelineChain,
  nextChainedJob,
  readChainSteps,
  stripChain,
} from "./chain";

describe("buildAutoPipelineChain", () => {
  it("chains the whole pipeline after a download", () => {
    const steps = buildAutoPipelineChain("download", { providerId: "openai" });
    expect(steps.map((s) => s.kind)).toEqual(["transcription", "analysis", "tracking"]);
    expect(steps[0].payload).toEqual({ providerId: "openai" });
  });

  it("chains only what is left when the media is already on disk", () => {
    const steps = buildAutoPipelineChain("transcription", { providerId: "assemblyai" });
    expect(steps.map((s) => s.kind)).toEqual(["analysis", "tracking"]);
  });

  it("ends the chain after the last step", () => {
    expect(buildAutoPipelineChain("tracking")).toEqual([]);
  });

  it("never starts a chain from a render: exporting is an endpoint", () => {
    expect(buildAutoPipelineChain("render", { providerId: "openai" })).toEqual([]);
  });

  it("refuses to chain a transcription with no provider rather than inventing one", () => {
    expect(() => buildAutoPipelineChain("download")).toThrow(ChainConfigurationError);
    expect(() => buildAutoPipelineChain("transcription")).not.toThrow();
  });

  it("passes the tracking engine and the re-cut request down to their steps", () => {
    const steps = buildAutoPipelineChain("download", {
      providerId: "openai",
      trackProvider: "stable-center-fallback",
      resegment: true,
    });
    const byKind = Object.fromEntries(steps.map((s) => [s.kind, s.payload]));
    expect(byKind.tracking).toEqual({ provider: "stable-center-fallback" });
    expect(byKind.analysis).toEqual({ resegment: true });
  });

  it("covers every kind of the declared pipeline order", () => {
    expect(buildAutoPipelineChain(AUTO_PIPELINE_ORDER[0], { providerId: "openai", motion: true })).toHaveLength(
      AUTO_PIPELINE_ORDER.length - 1
    );
  });
});

describe("readChainSteps / stripChain", () => {
  it("reads back the steps attached to a payload", () => {
    const payload = attachChain({ url: "https://x" }, [{ kind: "analysis", payload: {} }]);
    expect(readChainSteps(payload)).toEqual([{ kind: "analysis", payload: {} }]);
    expect(stripChain(payload)).toEqual({ url: "https://x" });
  });

  it("attaches nothing when there is no step to chain", () => {
    expect(attachChain({ a: 1 }, [])).toEqual({ a: 1 });
  });

  it("treats a malformed or foreign chain as no chain, leaving the job itself runnable", () => {
    for (const bad of [
      undefined,
      null,
      42,
      { [CHAIN_PAYLOAD_KEY]: "nope" },
      { [CHAIN_PAYLOAD_KEY]: [{ kind: "not-a-kind", payload: {} }] },
      { [CHAIN_PAYLOAD_KEY]: [{ kind: "analysis" }] },
      { [CHAIN_PAYLOAD_KEY]: [{ kind: "analysis", payload: [] }] },
      { [CHAIN_PAYLOAD_KEY]: [null] },
    ]) {
      expect(readChainSteps(bad)).toEqual([]);
    }
  });

  it("rejects the whole chain when any step is invalid, rather than running a partial one", () => {
    const payload = {
      [CHAIN_PAYLOAD_KEY]: [
        { kind: "analysis", payload: {} },
        { kind: "nonsense", payload: {} },
      ],
    };
    expect(readChainSteps(payload)).toEqual([]);
  });
});

describe("nextChainedJob", () => {
  it("returns the next step, carrying the rest of the chain forward", () => {
    const payload = attachChain(
      { url: "https://x" },
      [
        { kind: "transcription", payload: { providerId: "openai" } },
        { kind: "analysis", payload: {} },
      ]
    );
    const next = nextChainedJob({ id: "job-1", payload });
    expect(next).toEqual({
      kind: "transcription",
      payload: { providerId: "openai", [CHAIN_PAYLOAD_KEY]: [{ kind: "analysis", payload: {} }] },
      idempotencyKey: "chain:job-1",
    });
  });

  it("drops the chain key on the last step, so the pipeline ends there", () => {
    const payload = attachChain({}, [{ kind: "tracking", payload: {} }]);
    const next = nextChainedJob({ id: "job-9", payload });
    expect(next?.payload).toEqual({});
    expect(nextChainedJob({ id: "job-10", payload: next?.payload })).toBeNull();
  });

  it("returns null for a job that carries no chain", () => {
    expect(nextChainedJob({ id: "job-2", payload: { providerId: "openai" } })).toBeNull();
  });

  it("derives the idempotency key from the completed job's own id", () => {
    const payload = attachChain({}, [{ kind: "analysis", payload: {} }]);
    expect(nextChainedJob({ id: "a", payload })?.idempotencyKey).toBe("chain:a");
    expect(nextChainedJob({ id: "b", payload })?.idempotencyKey).toBe("chain:b");
  });
});

describe("buildAutoPipelineChain — Claude Motion", () => {
  it("closes the pipeline with the motion step only when the server says Claude is configured", () => {
    const kinds = (motion: boolean) =>
      buildAutoPipelineChain("analysis", { motion }).map((step) => step.kind);
    expect(kinds(true)).toEqual(["tracking", "motion"]);
    expect(kinds(false)).toEqual(["tracking"]);
  });
});
