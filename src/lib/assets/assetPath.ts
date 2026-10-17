import path from "node:path";
import { IMAGE_EXTENSIONS, isValidAssetId, isValidProjectId, type ImageMimeType } from "./imageAsset";

/**
 * Where an asset's bytes live, derived from ids rather than stored.
 *
 * Nothing in the database holds a filesystem path — the same rule
 * `sources` and the preview store already follow. A path is recomputed
 * from (base dir, project id, asset id, type), and both ids are checked
 * against their patterns first, so a value that came in over the network
 * cannot produce a path outside the store. The containment check that
 * follows is belt and braces: it would catch a future pattern that let
 * something through.
 */
export function assetFilePath(
  baseDir: string,
  projectId: string,
  assetId: string,
  mimeType: ImageMimeType
): string | null {
  if (!isValidProjectId(projectId) || !isValidAssetId(assetId)) return null;

  const extension = IMAGE_EXTENSIONS[mimeType];
  if (!extension) return null;

  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, projectId, `${assetId}${extension}`);
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

export function projectAssetsDir(baseDir: string, projectId: string): string | null {
  if (!isValidProjectId(projectId)) return null;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, projectId);
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}
