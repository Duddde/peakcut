import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export function isValidPreviewId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function previewOutputPath(previewsBaseDir: string, previewId: string): string {
  return path.join(previewsBaseDir, `${previewId}.mp4`);
}

export async function getFreshPreviewFile(
  previewsBaseDir: string,
  previewId: string,
  ttlMs = 15 * 60 * 1000,
  nowMs = Date.now()
): Promise<{ filePath: string; expiresAt: string } | null> {
  if (!isValidPreviewId(previewId)) return null;
  const filePath = previewOutputPath(previewsBaseDir, previewId);
  try {
    const info = await stat(filePath);
    const expiresAtMs = info.mtimeMs + ttlMs;
    if (expiresAtMs <= nowMs) {
      await unlink(filePath).catch(() => undefined);
      return null;
    }
    return { filePath, expiresAt: new Date(expiresAtMs).toISOString() };
  } catch {
    return null;
  }
}

export async function cleanupExpiredPreviews(
  previewsBaseDir: string,
  ttlMs = 15 * 60 * 1000,
  nowMs = Date.now()
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(previewsBaseDir);
  } catch {
    return;
  }
  await Promise.all(
    entries.filter((entry) => /^[0-9a-f-]{36}\.mp4$/i.test(entry)).map(async (entry) => {
      const filePath = path.join(previewsBaseDir, entry);
      try {
        if (nowMs - (await stat(filePath)).mtimeMs >= ttlMs) await unlink(filePath);
      } catch {
        // A concurrent cleanup or expiry is harmless.
      }
    })
  );
}
