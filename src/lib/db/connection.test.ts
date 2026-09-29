// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "./connection";

describe("openDatabase (real SQLite file)", () => {
  let baseDir: string;
  let dbPath: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "peakcut-connection-"));
    dbPath = path.join(baseDir, "peakcut.db");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("enables WAL journaling", () => {
    const db = openDatabase(dbPath);
    try {
      const [row] = db.prepare("PRAGMA journal_mode").all() as Array<{ journal_mode: string }>;
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys, which SQLite leaves off by default", () => {
    const db = openDatabase(dbPath);
    try {
      const [row] = db.prepare("PRAGMA foreign_keys").all() as Array<{ foreign_keys: number }>;
      expect(row.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });

  it("sets a non-zero busy timeout so a competing writer waits instead of crashing", () => {
    // Regression: with no timeout, the worker process died outright with
    // "database is locked" the first time it overlapped another writer.
    const db = openDatabase(dbPath);
    try {
      const [row] = db.prepare("PRAGMA busy_timeout").all() as Array<{ timeout: number }>;
      expect(row.timeout).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("lets a second connection write while a first one holds the same file", () => {
    const first = openDatabase(dbPath);
    const second = openDatabase(dbPath);
    try {
      first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      first.prepare("INSERT INTO t (v) VALUES (?)").run("depuis-la-premiere");
      second.prepare("INSERT INTO t (v) VALUES (?)").run("depuis-la-seconde");

      const rows = second.prepare("SELECT v FROM t ORDER BY id").all() as Array<{ v: string }>;
      expect(rows.map((r) => r.v)).toEqual(["depuis-la-premiere", "depuis-la-seconde"]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("creates the database file when it does not exist yet", () => {
    const db = openDatabase(path.join(baseDir, "nouveau.db"));
    try {
      expect(() => db.exec("CREATE TABLE t (id INTEGER)")).not.toThrow();
    } finally {
      db.close();
    }
  });
});
