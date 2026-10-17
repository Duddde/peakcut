import { resolveSharedDatabase } from "@/lib/appDeps";
import { createJobWorkerRuntime, TRIAL_CLEANUP_INTERVAL_MS } from "@/lib/jobs/runtime";
import { runJobWorker } from "@/lib/jobs/worker";

export interface InlineWorkerMode {
  enabled: boolean;
  /** Why, in one phrase, so startup logs explain themselves. */
  reason: string;
  /** Set when PEAKCUT_INLINE_WORKER held a value this code does not recognise. */
  warning?: string;
}

/**
 * Whether this Next.js server process should also drain the job queue
 * itself, instead of relying on the standalone worker process.
 *
 * Default: on outside production, off in production. Local development
 * then needs a single command (`npm run dev`) for the whole app, while a
 * real deployment keeps the job worker in its own process — long ffmpeg
 * renders and yt-dlp downloads must not share a restart policy with the
 * request-serving server (see deploy/peakcut-worker.service).
 *
 * `PEAKCUT_INLINE_WORKER=1` forces it on (a single-instance deployment
 * that accepts the trade-off), `=0` forces it off (running the standalone
 * worker in development). Any other value is ignored, with a warning,
 * rather than being guessed at.
 */
export function resolveInlineWorkerMode(env: NodeJS.ProcessEnv = process.env): InlineWorkerMode {
  const raw = env.PEAKCUT_INLINE_WORKER;
  const byDefault: InlineWorkerMode =
    env.NODE_ENV === "production"
      ? { enabled: false, reason: "désactivé par défaut en production" }
      : { enabled: true, reason: "activé par défaut hors production" };

  if (raw === "1") return { enabled: true, reason: "PEAKCUT_INLINE_WORKER=1" };
  if (raw === "0") return { enabled: false, reason: "PEAKCUT_INLINE_WORKER=0" };
  if (raw !== undefined && raw.trim() !== "") {
    return {
      ...byDefault,
      warning: `PEAKCUT_INLINE_WORKER="${raw}" n'est pas une valeur reconnue (attendu "1" ou "0") : valeur ignorée.`,
    };
  }
  return byDefault;
}

/**
 * Survives module re-evaluation (Next.js dev recompiles the module graph
 * on change) so a single process can never end up with two loops claiming
 * jobs. A fresh process gets a fresh global, which is exactly right.
 */
const STARTED = Symbol.for("peakcut.inlineWorker.started");
type GuardedGlobal = typeof globalThis & { [STARTED]?: true };

function log(message: string): void {
  process.stdout.write(`[peakcut-worker:inline] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[peakcut-worker:inline] ${message}\n`);
}

/**
 * Starts the job worker inside this Next.js server process, unless
 * disabled or already running. Returns whether a loop was started.
 *
 * Never throws and never blocks: it is called from instrumentation.ts,
 * whose `register()` must complete before the server accepts requests, so
 * the loop is deliberately left running in the background and a
 * misconfiguration is reported rather than propagated — a broken worker
 * must not take the web app down with it.
 */
export function startInlineWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolveInlineWorkerMode(env);
  if (mode.warning) logError(mode.warning);
  if (!mode.enabled) return false;

  const globals = globalThis as GuardedGlobal;
  if (globals[STARTED]) return false;
  globals[STARTED] = true;

  let runtime;
  try {
    runtime = createJobWorkerRuntime(resolveSharedDatabase(), env);
  } catch (err) {
    logError(
      `Démarrage impossible (${err instanceof Error ? err.message : String(err)}). ` +
        "Les jobs resteront en file jusqu'au lancement de `npm run worker`."
    );
    return false;
  }

  const controller = new AbortController();
  const stop = (signal: string) => {
    logError(`Signal ${signal} reçu, arrêt après le job en cours…`);
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const sweepTrials = async () => {
    try {
      const removed = await runtime.sweepExpiredTrials();
      if (removed > 0) log(`${removed} essai(s) public(s) expiré(s) supprimé(s).`);
    } catch (err) {
      logError(`Nettoyage des essais impossible : ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  log(`Worker de jobs démarré dans le serveur Next.js (${mode.reason}).`);

  void (async () => {
    const sweepTimer = setInterval(() => void sweepTrials(), TRIAL_CLEANUP_INTERVAL_MS);
    try {
      await sweepTrials();
      await runJobWorker({ repo: runtime.repo, handlers: runtime.handlers, signal: controller.signal });
    } catch (err) {
      // runJobWorker turns a failing handler into failJob on its own, so
      // reaching here means the queue itself is unusable (a locked or
      // deleted database). The loop is gone for the life of this process:
      // say so instead of letting jobs pile up in silence.
      logError(
        `Boucle arrêtée sur erreur : ${err instanceof Error ? err.message : String(err)}. ` +
          "Redémarrez le serveur, ou lancez `npm run worker` à côté."
      );
    } finally {
      clearInterval(sweepTimer);
    }
  })();

  return true;
}
