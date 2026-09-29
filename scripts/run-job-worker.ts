#!/usr/bin/env -S npx tsx
import path from "node:path";
import { loadEnvFiles } from "../src/lib/env/loadEnvFiles";
import { openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrations";
import { getDbConfig } from "../src/lib/db/config";
import { SqliteJobRepository } from "../src/lib/jobs/JobRepository";
import { createDefaultJobHandlers } from "../src/lib/jobs/handlers";
import { runJobWorker } from "../src/lib/jobs/worker";
import { JOB_KINDS, type JobKind } from "../src/lib/jobs/types";

/**
 * Standalone job-worker process — entirely separate from the Next.js HTTP
 * server, so a slow/stuck job (a real yt-dlp download, a real ffmpeg
 * render, a real transcription API call) never ties up a request thread.
 * Run this under the provided systemd unit (deploy/peakcut-worker.service) in production, or directly
 * with `--once` for a single bounded pass (used by tests and cron-style
 * invocation).
 *
 * This process is never started automatically by anything else in this
 * repo — see deploy/peakcut-worker.service for why.
 *
 * Unlike the Next.js server, a plain Node process gets no .env loading for
 * free, so this script does it itself before reading any config. Without
 * that, `npm run worker` died instantly on a missing PEAKCUT_DB_PATH while
 * the web app right next to it was running fine off .env.local — and jobs
 * simply sat in the queue, never claimed by anyone.
 */

interface CliOptions {
  once: boolean;
  kinds?: JobKind[];
  pollIntervalMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  let once = false;
  let kinds: JobKind[] | undefined;
  let pollIntervalMs = 1000;

  for (const arg of argv) {
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg.startsWith("--kinds=")) {
      const raw = arg.slice("--kinds=".length).split(",").map((s) => s.trim());
      const invalid = raw.filter((k) => !JOB_KINDS.includes(k as JobKind));
      if (invalid.length > 0) {
        throw new Error(`--kinds inconnu(s) : ${invalid.join(", ")}. Attendu parmi : ${JOB_KINDS.join(", ")}.`);
      }
      kinds = raw as JobKind[];
      continue;
    }
    if (arg.startsWith("--poll-interval-ms=")) {
      const value = Number(arg.slice("--poll-interval-ms=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--poll-interval-ms doit être un nombre positif.");
      }
      pollIntervalMs = value;
      continue;
    }
    throw new Error(`Argument inconnu : "${arg}". Attendu : --once, --kinds=<a,b>, --poll-interval-ms=<n>.`);
  }

  return { once, kinds, pollIntervalMs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Before getDbConfig(), which throws on a missing PEAKCUT_DB_PATH.
  const loadedEnvFiles = loadEnvFiles();
  if (loadedEnvFiles.length > 0) {
    process.stdout.write(`[peakcut-worker] Variables charg\u00e9es depuis : ${loadedEnvFiles.join(", ")}.\n`);
  }

  const { path: dbPath } = getDbConfig();
  const db = openDatabase(dbPath);
  runMigrations(db);

  const repo = new SqliteJobRepository(db);
  const exportsBaseDir = process.env.PEAKCUT_EXPORTS_DIR ?? path.join(process.cwd(), ".data", "exports");
  const downloadsBaseDir = process.env.PEAKCUT_DOWNLOADS_DIR ?? path.join(process.cwd(), ".data", "downloads");
  const handlers = createDefaultJobHandlers({ db, exportsBaseDir, downloadsBaseDir });

  const controller = new AbortController();
  const shutdown = (signal: string) => {
    process.stderr.write(`\n[peakcut-worker] Signal ${signal} reçu, arrêt après le job en cours…\n`);
    controller.abort();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const result = await runJobWorker({
    repo,
    handlers,
    kinds: options.kinds,
    once: options.once,
    pollIntervalMs: options.pollIntervalMs,
    signal: controller.signal,
  });

  process.stdout.write(`[peakcut-worker] Terminé : ${result.processed} job(s) traité(s) en ${result.iterations} itération(s).\n`);
}

main().catch((err) => {
  process.stderr.write(`[peakcut-worker] Erreur fatale : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
