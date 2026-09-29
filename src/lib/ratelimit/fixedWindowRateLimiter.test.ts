import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "./fixedWindowRateLimiter";

describe("createFixedWindowRateLimiter", () => {
  it("allows up to maxRequests within a window, then blocks", () => {
    const time = 0;
    const limiter = createFixedWindowRateLimiter({ maxRequests: 3, windowMs: 1000, now: () => time });

    expect(limiter.consume("ip-1").allowed).toBe(true);
    expect(limiter.consume("ip-1").allowed).toBe(true);
    expect(limiter.consume("ip-1").allowed).toBe(true);
    const blocked = limiter.consume("ip-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000, now: () => time });
    expect(limiter.consume("ip-1").allowed).toBe(true);
    expect(limiter.consume("ip-1").allowed).toBe(false);

    time = 1000;
    expect(limiter.consume("ip-1").allowed).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const limiter = createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.consume("ip-1").allowed).toBe(true);
    expect(limiter.consume("ip-2").allowed).toBe(true);
    expect(limiter.consume("ip-1").allowed).toBe(false);
  });
});
