/**
 * Client-safe export spec constants (no Node built-ins here). Both the
 * server-side exportSegment implementation and browser-side UI import
 * these so the "expected properties" shown to the user can never drift
 * from what the real ffmpeg export actually produces.
 */
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;
export const EXPORT_VIDEO_CODEC_LABEL = "H.264";
export const EXPORT_AUDIO_CODEC_LABEL = "AAC";
