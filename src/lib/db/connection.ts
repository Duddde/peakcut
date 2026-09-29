import { DatabaseSync } from "node:sqlite";

/**
 * How long a writer waits for a competing write lock before giving up.
 * Without it SQLite fails instantly with "database is locked", which is
 * not a theoretical risk here: the web app writes a row to `jobs` on every
 * enqueue while the worker is claiming/updating jobs in its own loop, and
 * WAL journaling only removes reader/writer contention, never
 * writer/writer. An unset timeout took the whole worker process down the
 * first time two of them overlapped.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens a SQLite database file (creating it if absent) with sane defaults
 * for a small local app: WAL journaling for better concurrent read/write
 * behavior, a busy timeout so concurrent writers queue instead of
 * crashing, and foreign keys enforced (SQLite disables them by default).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
