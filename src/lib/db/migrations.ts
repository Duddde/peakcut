import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Full local schema. No table ever stores binary media — `sources` only
 * ever holds a local filesystem path (string) or a YouTube URL (never
 * downloaded), and `export_jobs` only holds an opaque export_id, never a
 * server path (mirrors the API's own no-server-path-leak rule).
 */
const INIT_SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  timeline_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner_id ON projects(owner_id);

CREATE TABLE sources (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  youtube_url TEXT,
  local_file_path TEXT,
  duration_sec REAL NOT NULL,
  origin_timestamp TEXT NOT NULL,
  confidence REAL NOT NULL
);

CREATE TABLE transcripts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  words_json TEXT NOT NULL
);

CREATE TABLE workflows (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  publication_policy TEXT NOT NULL,
  rights_confirmed INTEGER NOT NULL,
  rights_confirmed_at TEXT,
  rights_confirmed_by TEXT
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  words_json TEXT NOT NULL,
  score_json TEXT,
  safe_zones_json TEXT NOT NULL,
  variants_json TEXT NOT NULL
);
CREATE INDEX idx_segments_project_id ON segments(project_id);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  export_id TEXT,
  error TEXT,
  render_applied_json TEXT,
  render_limitations_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_export_jobs_project_id ON export_jobs(project_id);
`;

/**
 * Google OAuth support: password_hash becomes optional (OAuth-only users
 * have none) and users gain a unique google_id for account linking.
 * SQLite has no ALTER COLUMN, so this is the standard rebuild pattern
 * (create new table, copy, drop, rename) — see runMigrations for why
 * foreign_keys is toggled off around every migration: dropping a
 * referenced table while FK enforcement is on cascades-deletes its
 * children (sessions here), which a same-named table rebuild must avoid.
 */
const ADD_GOOGLE_AUTH_SQL = `
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO users_new (id, email, password_hash, created_at)
  SELECT id, email, password_hash, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`;

/**
 * Async job queue, entirely local (no Redis, no external broker): a single
 * `jobs` table doubles as both the queue and the durable status/progress
 * record. `project_id` is nullable at the schema level for forward
 * compatibility, but every job actually created through the public API
 * must belong to an owned project (ownership is how access control works
 * here — an ownerless job would be unreachable through any authenticated
 * route). `idempotency_key` is UNIQUE but nullable; SQLite permits any
 * number of NULLs in a UNIQUE column, so jobs created without a key never
 * collide with each other.
 */
const ADD_JOBS_SQL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_project_id ON jobs(project_id);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "init_schema", sql: INIT_SCHEMA_SQL },
  { version: 2, name: "add_google_auth", sql: ADD_GOOGLE_AUTH_SQL },
  { version: 3, name: "add_jobs", sql: ADD_JOBS_SQL },
];

/**
 * Applies every migration not yet recorded in schema_migrations, each in
 * its own transaction. Idempotent: re-running on an up-to-date database is
 * a no-op. A migration that throws rolls back its own transaction and
 * re-throws — no partial schema is ever left committed.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );

  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((r) => Number(r.version)));

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    // PRAGMA foreign_keys is a no-op inside a transaction, so it must be
    // toggled outside BEGIN/COMMIT. Off during the migration so a
    // create-copy-drop-rename table rebuild never cascade-deletes rows in
    // other tables that reference it; back on immediately after.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}

export function getAppliedMigrationVersions(db: DatabaseSync): number[] {
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
  }>;
  return rows.map((r) => Number(r.version));
}
