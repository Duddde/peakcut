import type { CropAspectRatio, NormalizedRect, Variant } from "./types";

/**
 * Standard crop variants (9:16, 1:1, 4:5, 16:9), assuming a 16:9 source
 * frame. Shared by the demo analysis pipeline and any studio flow that
 * needs to synthesize a fresh Segment (e.g. after a real transcription)
 * without duplicating this crop math.
 */
const SOURCE_ASPECT = 16 / 9;

function cropForAspectRatio(aspectRatio: CropAspectRatio): NormalizedRect {
  const [w, h] = aspectRatio.split(":").map(Number);
  const targetAspect = w / h;
  if (targetAspect >= SOURCE_ASPECT) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const width = Number((targetAspect / SOURCE_ASPECT).toFixed(4));
  const x = Number(((1 - width) / 2).toFixed(4));
  return { x, y: 0, width, height: 1 };
}

export function buildDefaultVariants(ownerId: string): Variant[] {
  const aspectRatios: Array<{ ratio: CropAspectRatio; label: string }> = [
    { ratio: "9:16", label: "Vertical 9:16 (par défaut)" },
    { ratio: "1:1", label: "Carré 1:1" },
    { ratio: "4:5", label: "Portrait 4:5" },
    { ratio: "16:9", label: "Horizontal 16:9 (source)" },
  ];
  return aspectRatios.map(({ ratio, label }) => ({
    id: `${ownerId}-variant-${ratio.replace(":", "x")}`,
    label,
    aspectRatio: ratio,
    crop: cropForAspectRatio(ratio),
  }));
}
