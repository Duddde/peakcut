import type { PublicTrialLimitsSummary } from "./config";

/**
 * Browser-side view of the public trial. Client components never read the
 * PEAKCUT_PUBLIC_TRIAL flag themselves (it is server-only); they ask
 * /api/public-trial, which answers per request.
 */

export type { PublicTrialLimitsSummary };

export interface PublicTrialInfo {
  expiresAt: string;
  limits: PublicTrialLimitsSummary;
}

export type PublicTrialStatus =
  | { enabled: false }
  | { enabled: true; account: boolean; limits: PublicTrialLimitsSummary; trial: { expiresAt: string } | null };

function isLimits(value: unknown): value is PublicTrialLimitsSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["ttlMinutes", "maxDurationMinutes", "maxSizeMb", "maxDownloads", "maxRenders", "maxTranscriptions", "maxPreviewsPerHour"].every(
    (key) => typeof v[key] === "number"
  );
}

/** Any failure (network, malformed body, flag off) reads as "disabled" — the safe default. */
export async function fetchPublicTrialStatus(fetchImpl: typeof fetch = fetch): Promise<PublicTrialStatus> {
  try {
    const res = await fetchImpl("/api/public-trial", { cache: "no-store" });
    const json = (await res.json()) as Record<string, unknown> | null;
    if (!res.ok || json?.ok !== true || json.enabled !== true || !isLimits(json.limits)) return { enabled: false };
    const trial = json.trial as { expiresAt?: unknown } | null | undefined;
    return {
      enabled: true,
      account: json.account === true,
      limits: json.limits,
      trial: trial && typeof trial.expiresAt === "string" ? { expiresAt: trial.expiresAt } : null,
    };
  } catch {
    return { enabled: false };
  }
}

export function parsePublicTrialInfo(value: unknown): PublicTrialInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.expiresAt === "string" && isLimits(v.limits) ? { expiresAt: v.expiresAt, limits: v.limits } : null;
}

export function formatTrialExpiry(expiresAt: string): string {
  try {
    return new Date(expiresAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return expiresAt;
  }
}

/** "24 h", "1 h 30", "45 min" — the trial's lifetime as a visitor reads it. */
export function formatTrialDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

/** "2 Go", "1,5 Go", "300 Mo" (binary units, like describePublicTrialLimits). */
export function formatTrialSize(megabytes: number): string {
  if (megabytes < 1024) return `${megabytes} Mo`;
  const gigabytes = Math.round((megabytes / 1024) * 10) / 10;
  return `${String(gigabytes).replace(".", ",")} Go`;
}
