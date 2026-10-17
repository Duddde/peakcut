import { describe, expect, it } from "vitest";
import { resolveInlineWorkerMode } from "@/lib/jobs/inlineWorker";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveInlineWorkerMode", () => {
  it("runs the worker in the server outside production, so `npm run dev` needs nothing on the side", () => {
    expect(resolveInlineWorkerMode(env({ NODE_ENV: "development" }))).toMatchObject({ enabled: true });
    expect(resolveInlineWorkerMode(env({ NODE_ENV: "test" }))).toMatchObject({ enabled: true });
  });

  it("stays out of the production server, which keeps its standalone worker process", () => {
    expect(resolveInlineWorkerMode(env({ NODE_ENV: "production" }))).toMatchObject({ enabled: false });
  });

  it("is forced on by PEAKCUT_INLINE_WORKER=1, production included", () => {
    const mode = resolveInlineWorkerMode(env({ NODE_ENV: "production", PEAKCUT_INLINE_WORKER: "1" }));
    expect(mode.enabled).toBe(true);
    expect(mode.warning).toBeUndefined();
  });

  it("is forced off by PEAKCUT_INLINE_WORKER=0, development included", () => {
    const mode = resolveInlineWorkerMode(env({ NODE_ENV: "development", PEAKCUT_INLINE_WORKER: "0" }));
    expect(mode.enabled).toBe(false);
    expect(mode.warning).toBeUndefined();
  });

  it("ignores an unrecognised value with a warning instead of guessing at it", () => {
    for (const raw of ["true", "yes", "2", "off"]) {
      const mode = resolveInlineWorkerMode(env({ NODE_ENV: "production", PEAKCUT_INLINE_WORKER: raw }));
      expect(mode.enabled).toBe(false);
      expect(mode.warning).toContain(raw);
    }
    const dev = resolveInlineWorkerMode(env({ NODE_ENV: "development", PEAKCUT_INLINE_WORKER: "true" }));
    expect(dev.enabled).toBe(true);
    expect(dev.warning).toContain("true");
  });

  it("treats an empty value as unset rather than as a warning", () => {
    const mode = resolveInlineWorkerMode(env({ NODE_ENV: "development", PEAKCUT_INLINE_WORKER: "  " }));
    expect(mode.enabled).toBe(true);
    expect(mode.warning).toBeUndefined();
  });
});
