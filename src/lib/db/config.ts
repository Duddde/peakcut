export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export interface DbConfig {
  path: string;
}

/**
 * Reads the SQLite database path from the environment. Throws an explicit
 * configuration error rather than silently defaulting to some path (e.g.
 * an in-memory or temp-file database) — a missing PEAKCUT_DB_PATH must
 * never quietly downgrade persistence.
 */
export function getDbConfig(): DbConfig {
  const path = process.env.PEAKCUT_DB_PATH;
  if (!path || path.trim().length === 0) {
    throw new DatabaseConfigError(
      "PEAKCUT_DB_PATH n'est pas configuré : définissez le chemin du fichier SQLite (ex. ./data/peakcut.db)."
    );
  }
  return { path };
}
