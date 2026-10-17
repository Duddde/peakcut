import type { DatabaseSync } from "node:sqlite";
import { getDbConfig } from "@/lib/db/config";
import { getAuthSecret } from "@/lib/auth/authConfig";
import { openDatabase } from "@/lib/db/connection";
import { runMigrations } from "@/lib/db/migrations";

export interface AppDeps {
  db: DatabaseSync;
  authSecret: string;
}

let cachedDb: DatabaseSync | null = null;
let cachedDbPath: string | null = null;

function getSharedDatabase(path: string): DatabaseSync {
  if (cachedDb && cachedDbPath === path) return cachedDb;
  const db = openDatabase(path);
  runMigrations(db);
  cachedDb = db;
  cachedDbPath = path;
  return db;
}

/**
 * Resolves the shared app dependencies (DB connection, auth secret) from
 * the environment. Throws DatabaseConfigError / AuthConfigError when
 * misconfigured — callers MUST invoke this lazily, inside a request
 * handler, never at module load time, or a missing env var would crash
 * `next build` itself instead of failing a single request cleanly.
 */
export function resolveAppDeps(): AppDeps {
  const { path } = getDbConfig();
  const authSecret = getAuthSecret();
  const db = getSharedDatabase(path);
  return { db, authSecret };
}

/**
 * The same migrated, process-wide connection as resolveAppDeps(), for the
 * one caller that needs the database without being a request handler: the
 * in-server job worker (src/lib/jobs/inlineWorker.ts). It must not require
 * an auth secret — a worker never verifies a session — and must not open a
 * second connection to the same file from inside this process.
 */
export function resolveSharedDatabase(): DatabaseSync {
  const { path } = getDbConfig();
  return getSharedDatabase(path);
}
