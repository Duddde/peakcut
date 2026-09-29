import type { SafeZone, SafeZonePurpose } from "@/lib/domain/types";
import { EXPORT_WIDTH, EXPORT_HEIGHT } from "@/lib/ffmpeg/exportSpec";

export type PlatformVariantId = "tiktok" | "shorts";

export interface PlatformVariantSpec {
  id: PlatformVariantId;
  displayName: string;
  widthPx: number;
  heightPx: number;
  videoCodec: "h264";
  audioCodec: "aac";
  minDurationSec: number;
  maxDurationSec: number;
  requiredSafeZonePurposes: SafeZonePurpose[];
  metadata: { maxTitleLength: number };
}

const REQUIRED_SAFE_ZONES: SafeZonePurpose[] = [
  "subtitle-area",
  "platform-ui-top",
  "platform-ui-bottom",
];

/**
 * Named export presets with real, checkable constraints. Width/height/codec
 * always mirror PeakCut's fixed export spec (see lib/ffmpeg/exportSpec) —
 * there is only one real render pipeline, these are just named constraint
 * sets layered on top of it, not alternate encoders.
 */
export const PLATFORM_VARIANTS: Record<PlatformVariantId, PlatformVariantSpec> = {
  tiktok: {
    id: "tiktok",
    displayName: "TikTok",
    widthPx: EXPORT_WIDTH,
    heightPx: EXPORT_HEIGHT,
    videoCodec: "h264",
    audioCodec: "aac",
    minDurationSec: 1,
    maxDurationSec: 600,
    requiredSafeZonePurposes: REQUIRED_SAFE_ZONES,
    metadata: { maxTitleLength: 150 },
  },
  shorts: {
    id: "shorts",
    displayName: "YouTube Shorts",
    widthPx: EXPORT_WIDTH,
    heightPx: EXPORT_HEIGHT,
    videoCodec: "h264",
    audioCodec: "aac",
    minDurationSec: 1,
    maxDurationSec: 60,
    requiredSafeZonePurposes: REQUIRED_SAFE_ZONES,
    metadata: { maxTitleLength: 100 },
  },
};

export interface PlatformVariantCheckInput {
  variantId: PlatformVariantId;
  durationSec: number;
  safeZones: SafeZone[];
  title?: string;
}

export interface PlatformVariantCheckResult {
  ok: boolean;
  errors: string[];
  spec: PlatformVariantSpec;
}

export function checkPlatformVariant(input: PlatformVariantCheckInput): PlatformVariantCheckResult {
  const spec = PLATFORM_VARIANTS[input.variantId];
  if (!spec) {
    throw new Error(`Variante de plateforme inconnue : "${input.variantId}".`);
  }

  const errors: string[] = [];

  if (input.durationSec < spec.minDurationSec) {
    errors.push(`Durée trop courte pour ${spec.displayName} (minimum ${spec.minDurationSec}s).`);
  }
  if (input.durationSec > spec.maxDurationSec) {
    errors.push(`Durée trop longue pour ${spec.displayName} (maximum ${spec.maxDurationSec}s).`);
  }

  const presentPurposes = new Set(input.safeZones.map((z) => z.purpose));
  for (const purpose of spec.requiredSafeZonePurposes) {
    if (!presentPurposes.has(purpose)) {
      errors.push(`Zone de sécurité manquante pour ${spec.displayName} : "${purpose}".`);
    }
  }

  if (input.title && input.title.length > spec.metadata.maxTitleLength) {
    errors.push(`Titre trop long pour ${spec.displayName} (maximum ${spec.metadata.maxTitleLength} caractères).`);
  }

  return { ok: errors.length === 0, errors, spec };
}
