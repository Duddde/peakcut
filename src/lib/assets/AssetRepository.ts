import type { DatabaseSync } from "node:sqlite";

/**
 * Metadata for the illustrations a project can lay over its clips.
 *
 * No path, by design: the bytes' location is derived from the ids (see
 * assetPath.ts). `projectId` is on every lookup rather than only on
 * insert, because an asset id arriving from a client must only ever
 * resolve inside the project the caller owns — ownership is checked on
 * the project, so scoping the query to it is what makes that check mean
 * something.
 */

export type AssetOrigin = "upload" | "generated";

export interface AssetRecord {
  id: string;
  projectId: string;
  mimeType: string;
  sizeBytes: number;
  origin: AssetOrigin;
  /** The prompt a generated illustration came from; null for an upload. */
  prompt: string | null;
  /** The image provider that produced it; null for an upload. */
  providerId: string | null;
  createdAt: string;
}

export interface AssetRepository {
  createAsset(asset: AssetRecord): void;
  getAsset(projectId: string, assetId: string): AssetRecord | null;
  listAssets(projectId: string): AssetRecord[];
  deleteAsset(projectId: string, assetId: string): boolean;
}

interface AssetRow {
  id: string;
  project_id: string;
  mime_type: string;
  size_bytes: number;
  origin: string;
  prompt: string | null;
  provider_id: string | null;
  created_at: string;
}

function toRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    origin: row.origin === "generated" ? "generated" : "upload",
    prompt: row.prompt,
    providerId: row.provider_id,
    createdAt: row.created_at,
  };
}

export class SqliteAssetRepository implements AssetRepository {
  constructor(private readonly db: DatabaseSync) {}

  createAsset(asset: AssetRecord): void {
    this.db
      .prepare(
        `INSERT INTO assets (id, project_id, mime_type, size_bytes, origin, prompt, provider_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        asset.id,
        asset.projectId,
        asset.mimeType,
        asset.sizeBytes,
        asset.origin,
        asset.prompt,
        asset.providerId,
        asset.createdAt
      );
  }

  getAsset(projectId: string, assetId: string): AssetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?")
      .get(projectId, assetId) as AssetRow | undefined;
    return row ? toRecord(row) : null;
  }

  listAssets(projectId: string): AssetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC, id ASC")
      .all(projectId) as unknown as AssetRow[];
    return rows.map(toRecord);
  }

  deleteAsset(projectId: string, assetId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM assets WHERE project_id = ? AND id = ?")
      .run(projectId, assetId);
    return Number(result.changes) > 0;
  }
}
