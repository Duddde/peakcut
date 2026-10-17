import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetOrigin, AssetRecord, AssetRepository } from "./AssetRepository";
import { assetFilePath, projectAssetsDir } from "./assetPath";
import { isImageMimeType, validateImageAsset, type ImageMimeType } from "./imageAsset";

/**
 * The project's illustration store: bytes on disk, metadata in SQLite,
 * one id tying the two together.
 *
 * The row is written only after the file is, so a record never points at
 * bytes that do not exist. The reverse — a file with no row — is possible
 * if the process dies in between, and is harmless: nothing can reach a
 * file without its row, since every read goes through the project-scoped
 * lookup.
 */

export class AssetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetStoreError";
  }
}

export interface AssetStoreOptions {
  /** Root of the asset store; each project gets a subdirectory. */
  baseDir: string;
  repo: AssetRepository;
  newId?: () => string;
  now?: () => string;
}

export interface SaveAssetInput {
  projectId: string;
  data: Buffer;
  /** What the caller says the bytes are, when it says anything; contradicted by the content, the save is refused. */
  declaredMimeType?: string;
  origin: AssetOrigin;
  prompt?: string | null;
  providerId?: string | null;
}

export async function saveAsset(input: SaveAssetInput, options: AssetStoreOptions): Promise<AssetRecord> {
  const check = validateImageAsset({ data: input.data, declaredMimeType: input.declaredMimeType });
  if (!check.ok) throw new AssetStoreError(check.error);

  const id = (options.newId ?? randomUUID)();
  const filePath = assetFilePath(options.baseDir, input.projectId, id, check.mimeType);
  const dir = projectAssetsDir(options.baseDir, input.projectId);
  if (!filePath || !dir) {
    throw new AssetStoreError("Identifiant de projet ou d'illustration invalide.");
  }

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, input.data);

  const record: AssetRecord = {
    id,
    projectId: input.projectId,
    mimeType: check.mimeType,
    sizeBytes: input.data.length,
    origin: input.origin,
    prompt: input.prompt ?? null,
    providerId: input.providerId ?? null,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  options.repo.createAsset(record);
  return record;
}

/**
 * The file backing an asset of this project, or null when there is no
 * such asset — a missing row and a missing file are deliberately
 * indistinguishable to the caller, so neither can be used to probe what
 * exists on the machine.
 */
export function assetPathOf(record: AssetRecord, baseDir: string): string | null {
  if (!isImageMimeType(record.mimeType)) return null;
  return assetFilePath(baseDir, record.projectId, record.id, record.mimeType as ImageMimeType);
}

export interface LoadedAsset {
  record: AssetRecord;
  data: Buffer;
}

export async function readAsset(
  projectId: string,
  assetId: string,
  options: AssetStoreOptions
): Promise<LoadedAsset | null> {
  const record = options.repo.getAsset(projectId, assetId);
  if (!record) return null;
  const filePath = assetPathOf(record, options.baseDir);
  if (!filePath) return null;
  try {
    return { record, data: await readFile(filePath) };
  } catch {
    return null;
  }
}

/** Removes the row and the bytes. Returns false when there was nothing to remove. */
export async function deleteAsset(
  projectId: string,
  assetId: string,
  options: AssetStoreOptions
): Promise<boolean> {
  const record = options.repo.getAsset(projectId, assetId);
  if (!record) return false;
  const filePath = assetPathOf(record, options.baseDir);
  options.repo.deleteAsset(projectId, assetId);
  if (filePath) await unlink(filePath).catch(() => undefined);
  return true;
}

/** Default location of the store, beside the other local data directories. */
export function defaultAssetsBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PEAKCUT_ASSETS_DIR?.trim() || path.join(process.cwd(), ".data", "assets");
}
