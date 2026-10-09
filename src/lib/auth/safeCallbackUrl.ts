export const DEFAULT_CALLBACK_URL = "/projects";

/** Where the public landing-page demo sends a visitor back after signing in. */
export const PUBLIC_DEMO_CALLBACK_URL = "/#studio";

const PROBE_ORIGIN = "http://peakcut.invalid";

/**
 * Only a same-origin, path-relative destination is ever accepted. A
 * `callbackUrl` arrives from the query string, so an absolute,
 * protocol-relative (`//evil`) or backslash (`/\evil`, which browsers
 * normalise to `//evil`) one would turn sign-in into an open redirect.
 */
export function safeCallbackUrl(raw: unknown, fallback: string = DEFAULT_CALLBACK_URL): string {
  if (typeof raw !== "string") return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    if (new URL(raw, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

/** The current page as a relative URL (path + query + hash), never the absolute href. */
export function relativeUrlOf(location: Pick<Location, "pathname" | "search" | "hash">): string {
  return safeCallbackUrl(`${location.pathname}${location.search}${location.hash}`, "/");
}
