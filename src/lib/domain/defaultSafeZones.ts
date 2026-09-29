import type { SafeZone } from "./types";

/**
 * Standard safe zones for a 1080x1920 vertical export: the bottom subtitle
 * band and the top/bottom platform UI reserves (profile pic, caption,
 * like/share rail on TikTok/Shorts-style players). Shared by the demo
 * analysis pipeline and the effect template engine so both always agree on
 * where captions and platform chrome must not be covered.
 */
export function buildDefaultSafeZones(ownerId: string): SafeZone[] {
  return [
    {
      id: `${ownerId}-safezone-subtitles`,
      purpose: "subtitle-area",
      label: "Zone sous-titres",
      rect: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
    },
    {
      id: `${ownerId}-safezone-ui-top`,
      purpose: "platform-ui-top",
      label: "Zone UI plateforme (haut)",
      rect: { x: 0, y: 0, width: 1, height: 0.08 },
    },
    {
      id: `${ownerId}-safezone-ui-bottom`,
      purpose: "platform-ui-bottom",
      label: "Zone UI plateforme (bas)",
      rect: { x: 0, y: 0.92, width: 1, height: 0.08 },
    },
  ];
}
