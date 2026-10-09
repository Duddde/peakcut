import path from "node:path";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { SqliteTrialActorRepository } from "./TrialActorRepository";

export interface TrialStorageRoots {
  downloadsBaseDir: string;
  uploadsBaseDir: string;
  exportsBaseDir: string;
}

/** Same env conventions as the worker script and the media routes. */
export function resolveTrialStorageRoots(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): TrialStorageRoots {
  return {
    downloadsBaseDir: env.PEAKCUT_DOWNLOADS_DIR ?? path.join(cwd, ".data", "downloads"),
    uploadsBaseDir: env.PEAKCUT_UPLOADS_DIR ?? path.join(cwd, ".data", "uploads"),
    exportsBaseDir: env.PEAKCUT_EXPORTS_DIR ?? path.join(cwd, ".data", "exports"),
  };
}

function isStrictlyInside(candidate: string, baseDir: string): boolean {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidate);
  return resolved.startsWith(base + path.sep);
}

/**
 * The on-disk target to remove for one recorded media path, or null when
 * the path is outside every known storage root (it is then left alone — a
 * row in the DB is never trusted to point rm at an arbitrary file). A
 * download lives in its own per-download directory (see
 * createYtDlpDownloader), so that whole directory goes.
 */
export function deletionTargetFor(recordedPath: string, roots: TrialStorageRoots): string | null {
  const resolved = path.resolve(recordedPath);
  const downloads = path.resolve(roots.downloadsBaseDir);
  if (isStrictlyInside(resolved, downloads)) {
    const relative = path.relative(downloads, resolved);
    const [firstSegment] = relative.split(path.sep);
    return path.join(downloads, firstSegment);
  }
  if (isStrictlyInside(resolved, roots.uploadsBaseDir) || isStrictlyInside(resolved, roots.exportsBaseDir)) {
    return resolved;
  }
  return null;
}

function collectPathsFromJson(value: unknown, keys: Set<string>, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromJson(item, keys, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key) && typeof val === "string") out.add(val);
      else collectPathsFromJson(val, keys, out);
    }
  }
}

const RECORDED_PATH_KEYS = new Set(["localFilePath", "outputPath", "storedPath"]);

/**
 * Every media file a trial user's projects reference: the current source,
 * plus anything earlier jobs produced (a replaced download, rendered clips).
 */
export function listTrialMediaPaths(db: DatabaseSync, userId: string): string[] {
  const out = new Set<string>();
  const sources = db
    .prepare(
      `SELECT s.local_file_path AS local_file_path
       FROM sources s JOIN projects p ON p.id = s.project_id
       WHERE p.owner_id = ? AND s.local_file_path IS NOT NULL`
    )
    .all(userId) as Array<{ local_file_path: string }>;
  for (const row of sources) out.add(row.local_file_path);

  const jobs = db
    .prepare(
      `SELECT j.result_json AS result_json
       FROM jobs j JOIN projects p ON p.id = j.project_id
       WHERE p.owner_id = ? AND j.result_json IS NOT NULL`
    )
    .all(userId) as Array<{ result_json: string }>;
  for (const row of jobs) {
    try {
      collectPathsFromJson(JSON.parse(row.result_json), RECORDED_PATH_KEYS, out);
    } catch {
      // A malformed result can't reference anything we could safely remove.
    }
  }
  return [...out];
}

export interface DeleteTrialDeps {
  roots: TrialStorageRoots;
  /** Injected in tests. */
  removePath?: (target: string) => Promise<void>;
}

const defaultRemovePath = (target: string) => rm(target, { recursive: true, force: true });

/**
 * Removes one trial actor entirely: its media files first (while the DB
 * still says where they are), then the backing user row — which cascades
 * to its projects, sources, segments, workflows and jobs. Only ever acts on
 * a user that is a trial actor.
 */
export async function deleteTrialActorAndData(db: DatabaseSync, userId: string, deps: DeleteTrialDeps): Promise<boolean> {
  const repo = new SqliteTrialActorRepository(db);
  if (!repo.isTrialUser(userId)) return false;

  const removePath = deps.removePath ?? defaultRemovePath;
  const targets = new Set<string>();
  for (const recorded of listTrialMediaPaths(db, userId)) {
    const target = deletionTargetFor(recorded, deps.roots);
    if (target) targets.add(target);
  }
  for (const target of targets) {
    await removePath(target).catch(() => undefined);
  }
  return repo.delete(userId);
}

/** Deletes every expired trial actor and its data. Returns how many were removed. */
export async function cleanupExpiredTrials(
  db: DatabaseSync,
  deps: DeleteTrialDeps & { nowMs?: number }
): Promise<number> {
  const expired = new SqliteTrialActorRepository(db).listExpired(deps.nowMs ?? Date.now());
  let removed = 0;
  for (const actor of expired) {
    if (await deleteTrialActorAndData(db, actor.userId, deps)) removed++;
  }
  return removed;
}
