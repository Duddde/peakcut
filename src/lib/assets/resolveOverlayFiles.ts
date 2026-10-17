import { existsSync } from "node:fs";
import type { RenderPlan } from "@/lib/effects/types";
import type { AssetRepository } from "./AssetRepository";
import { assetPathOf } from "./assetStore";

/**
 * Turns the asset ids in a clip's plan into real files for the renderer.
 *
 * This is the only place an id becomes a path, and it is scoped to one
 * project: an overlay naming an asset of someone else's project resolves
 * to nothing, exactly as if the asset did not exist. The renderer then
 * skips that illustration and says so — see exportSegment — so a plan
 * cannot be used to read a file the caller has no claim to, and cannot
 * make an export fail either.
 *
 * A row whose bytes have gone missing is treated the same way: the file
 * is checked before it is handed over, because ffmpeg's own failure on a
 * missing input would take the whole clip down with it.
 */
export interface ResolveOverlayFilesOptions {
  repo: AssetRepository;
  baseDir: string;
  /** Injected in tests; defaults to a real filesystem check. */
  fileExists?: (path: string) => boolean;
}

export function resolveOverlayFiles(
  plan: RenderPlan | null | undefined,
  projectId: string,
  options: ResolveOverlayFilesOptions
): Record<string, string> {
  if (!plan || plan.overlays.length === 0) return {};
  const fileExists = options.fileExists ?? existsSync;

  const files: Record<string, string> = {};
  for (const overlay of plan.overlays) {
    if (files[overlay.assetId]) continue;
    const record = options.repo.getAsset(projectId, overlay.assetId);
    if (!record) continue;
    const filePath = assetPathOf(record, options.baseDir);
    if (!filePath || !fileExists(filePath)) continue;
    files[overlay.assetId] = filePath;
  }
  return files;
}
