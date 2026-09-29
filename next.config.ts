import type { NextConfig } from "next";

/**
 * Security headers for a locally-run editing tool. The CSP intentionally
 * allows 'unsafe-inline' for styles (React inline `style` attributes used
 * for dynamic timeline/crop widths, and Tailwind's own injected styles) but
 * allows the inline bootstrap scripts required by Next.js App Router, keeps
 * external scripts same-origin, disallows framing entirely, and
 * allows blob: media so the local file preview (<video src="blob:...">)
 * in the studio UI keeps working.
 */

/**
 * React's *development* build calls eval() for debugging features such as
 * reconstructing a callstack from another environment, and Turbopack's dev
 * runtime evaluates modules the same way. Without 'unsafe-eval' the browser
 * blocks it and the dev console fills with "eval() is not supported in this
 * environment".
 *
 * This is deliberately scoped to non-production builds only. React never
 * uses eval() in production, so shipping 'unsafe-eval' to real users would
 * weaken the policy against XSS for no benefit at all — the whole point of
 * the directive is to make an injected string non-executable.
 */
function scriptSrcDirective(isProduction: boolean): string {
  const sources = ["'self'", "'unsafe-inline'"];
  if (!isProduction) sources.push("'unsafe-eval'");
  return `script-src ${sources.join(" ")}`;
}

export function buildContentSecurityPolicy(env: NodeJS.ProcessEnv = process.env): string {
  const isProduction = env.NODE_ENV === "production";

  return [
    "default-src 'self'",
    scriptSrcDirective(isProduction),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // 'self' also covers the same-origin ws:// connection Turbopack uses for
    // hot reload, so dev needs no extra source here.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function buildSecurityHeaders(env: NodeJS.ProcessEnv = process.env) {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    },
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(env) },
  ];
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders(),
      },
    ];
  },
};

export default nextConfig;
