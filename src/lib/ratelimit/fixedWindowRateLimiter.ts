/**
 * A minimal in-memory, fixed-window rate limiter. This is a single-process
 * mitigation only (no Redis, no shared state across instances) — adequate
 * to blunt casual abuse of an anonymous, unauthenticated endpoint (like
 * /api/preview-segment) in this MVP, but NOT a substitute for a real edge
 * rate limiter in a multi-instance production deployment. Documented here
 * rather than silently pretended away.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the current window resets, only set when `allowed` is false. */
  retryAfterMs?: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitResult;
}

interface Window {
  count: number;
  windowStartMs: number;
}

export function createFixedWindowRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const { maxRequests, windowMs, now = () => Date.now() } = options;
  const windows = new Map<string, Window>();

  return {
    consume(key: string): RateLimitResult {
      const current = now();
      const existing = windows.get(key);

      if (!existing || current - existing.windowStartMs >= windowMs) {
        windows.set(key, { count: 1, windowStartMs: current });
        return { allowed: true };
      }

      if (existing.count < maxRequests) {
        existing.count += 1;
        return { allowed: true };
      }

      return { allowed: false, retryAfterMs: windowMs - (current - existing.windowStartMs) };
    },
  };
}
