import { describe, expect, it } from "vitest";
import nextConfig, { buildContentSecurityPolicy } from "./next.config";

async function getHeadersFor(pathname: string) {
  const rules = await nextConfig.headers!();
  const rule = rules.find((r) => r.source === pathname) ?? rules[0];
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
}

describe("next.config headers()", () => {
  it("sets X-Content-Type-Options to nosniff", async () => {
    const headers = await getHeadersFor("/(.*)");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("sets a Referrer-Policy", async () => {
    const headers = await getHeadersFor("/(.*)");
    expect(headers["Referrer-Policy"]).toBeTruthy();
  });

  it("sets X-Frame-Options to deny framing", async () => {
    const headers = await getHeadersFor("/(.*)");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("sets a restrictive Permissions-Policy", async () => {
    const headers = await getHeadersFor("/(.*)");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("microphone=()");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("sets a Content-Security-Policy allowing self-hosted assets, blob: media, and no framing", async () => {
    const headers = await getHeadersFor("/(.*)");
    const csp = headers["Content-Security-Policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
  });

  it("allows eval only outside production, where React's dev build needs it", () => {
    const dev = buildContentSecurityPolicy({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv);
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });

  it("never ships 'unsafe-eval' to production, where it would only weaken XSS protection", () => {
    const prod = buildContentSecurityPolicy({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    expect(prod).toContain("script-src 'self' 'unsafe-inline'");
    expect(prod).not.toContain("unsafe-eval");
  });

  it("keeps every other directive identical between production and development", () => {
    const strip = (csp: string) => csp.split("; ").filter((d) => !d.startsWith("script-src"));
    expect(strip(buildContentSecurityPolicy({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv))).toEqual(
      strip(buildContentSecurityPolicy({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv))
    );
  });

  it("applies the header rule to every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.some((r) => r.source === "/(.*)")).toBe(true);
  });
});
