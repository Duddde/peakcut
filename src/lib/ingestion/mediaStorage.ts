import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface StoredMedia {
  storedPath: string;
  sizeBytes: number;
}

export interface MediaStorage {
  save(filename: string, data: Buffer): Promise<StoredMedia>;
}

/**
 * Only the basename is ever used to derive the stored filename, so a
 * crafted `filename` containing ".." or path separators cannot escape
 * baseDir — this is a defense-in-depth check independent of
 * validateUploadMetadata, which already rejects such filenames upstream.
 */
function safeExtension(filename: string): string {
  const base = path.basename(filename);
  const ext = path.extname(base);
  return ext && /^\.[a-zA-Z0-9]+$/.test(ext) ? ext.toLowerCase() : "";
}

/**
 * Local-disk MediaStorage. This is the storage backend for the MVP: real
 * files, written under a single configurable base directory. No network
 * call, no external bucket, no credentials.
 */
export function createLocalMediaStorage(baseDir: string): MediaStorage {
  const resolvedBase = path.resolve(baseDir);

  return {
    async save(filename: string, data: Buffer): Promise<StoredMedia> {
      await mkdir(resolvedBase, { recursive: true });
      const extension = safeExtension(filename);
      const storedFilename = `${randomUUID()}${extension}`;
      const storedPath = path.join(resolvedBase, storedFilename);
      await writeFile(storedPath, data);
      return { storedPath, sizeBytes: data.length };
    },
  };
}
