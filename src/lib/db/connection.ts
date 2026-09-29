import { DatabaseSync } from "node:sqlite";

/**
 * Opens a SQLite database file (creating it if absent) with sane defaults
 * for a small local app: WAL journaling for better concurrent read/write
 * behavior, and foreign keys enforced (SQLite disables them by default).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
