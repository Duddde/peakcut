import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import type { AppDeps } from "@/lib/appDeps";

/** A fresh, migrated in-memory database + fixed test auth secret, for route/repository tests. */
export function createTestAppDeps(): AppDeps {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return { db, authSecret: "test-only-secret-" + "x".repeat(20) };
}
