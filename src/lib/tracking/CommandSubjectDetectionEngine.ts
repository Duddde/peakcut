import { spawn } from "node:child_process";
import type { DetectedBoundingBox, SubjectDetectionEngine, SubjectDetectionInput } from "./types";

/**
 * The one real, optional SubjectDetectionEngine PeakCut ships: it runs a
 * *local* external command (configured via PEAKCUT_TRACKER_COMMAND, e.g. a
 * Python/Node script wrapping a real detection model) and parses its JSON
 * stdout. PeakCut itself contains no detection model or weights.
 *
 * Security/trust posture:
 * - The command is always invoked via `spawn(command, args)` with `args`
 *   as a plain array — never through a shell, never string-concatenated,
 *   so there is no command-injection surface even though `mediaPath` is
 *   user-influenced.
 * - The spawned process receives a minimal, explicit environment (just
 *   PATH) rather than inheriting the parent's full environment, so it can
 *   never read PeakCut's own API keys or other secrets.
 * - Output is strictly schema-validated; anything that doesn't match is
 *   rejected outright rather than partially trusted.
 */

export class TrackerCommandNotConfiguredError extends Error {
  constructor() {
    super(
      "Aucun moteur de détection externe n'est configuré : définissez PEAKCUT_TRACKER_COMMAND pour en activer un."
    );
    this.name = "TrackerCommandNotConfiguredError";
  }
}

export class TrackerCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Le moteur de détection externe a dépassé le délai d'attente (${timeoutMs}ms).`);
    this.name = "TrackerCommandTimeoutError";
  }
}

export class TrackerCommandExecutionError extends Error {
  constructor(code: number | null, stderr: string) {
    super(`Le moteur de détection externe a échoué (code ${code}) : ${stderr.slice(-1000)}`);
    this.name = "TrackerCommandExecutionError";
  }
}

export class TrackerCommandInvalidOutputError extends Error {
  constructor(reason: string) {
    super(`Sortie invalide du moteur de détection externe : ${reason}`);
    this.name = "TrackerCommandInvalidOutputError";
  }
}

export interface CommandSubjectDetectionEngineOptions {
  /** Overrides process.env.PEAKCUT_TRACKER_COMMAND — mainly for tests. */
  command?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseDetections(stdout: string): DetectedBoundingBox[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new TrackerCommandInvalidOutputError("la sortie standard n'est pas un JSON valide.");
  }
  if (!Array.isArray(parsed)) {
    throw new TrackerCommandInvalidOutputError("la sortie JSON doit être un tableau.");
  }

  return parsed.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TrackerCommandInvalidOutputError(`l'entrée [${index}] doit être un objet.`);
    }
    const b = raw as Record<string, unknown>;
    if (
      !isFiniteNumber(b.tSec) ||
      b.tSec < 0 ||
      !isFiniteNumber(b.x) ||
      !isFiniteNumber(b.y) ||
      !isFiniteNumber(b.width) ||
      !isFiniteNumber(b.height) ||
      b.width <= 0 ||
      b.height <= 0 ||
      !isFiniteNumber(b.score) ||
      b.score < 0 ||
      b.score > 1
    ) {
      throw new TrackerCommandInvalidOutputError(`l'entrée [${index}] ne respecte pas le schéma attendu.`);
    }
    if (b.trackId !== undefined && typeof b.trackId !== "string") {
      throw new TrackerCommandInvalidOutputError(`l'entrée [${index}].trackId doit être une chaîne.`);
    }
    return {
      tSec: b.tSec,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      score: b.score,
      trackId: b.trackId as string | undefined,
    };
  });
}

export class CommandSubjectDetectionEngine implements SubjectDetectionEngine {
  readonly id = "command-subject-detector";

  constructor(private readonly options: CommandSubjectDetectionEngineOptions = {}) {}

  async detect(input: SubjectDetectionInput): Promise<DetectedBoundingBox[]> {
    const command = this.options.command ?? process.env.PEAKCUT_TRACKER_COMMAND;
    if (!command) {
      throw new TrackerCommandNotConfiguredError();
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = [
      input.mediaPath,
      String(input.sourceWidth),
      String(input.sourceHeight),
      String(input.durationSec),
    ];

    const stdout = await runCommand(command, args, timeoutMs);
    return parseDetections(stdout);
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new TrackerCommandExecutionError(null, err.message));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TrackerCommandTimeoutError(timeoutMs));
        return;
      }
      if (code !== 0) {
        reject(new TrackerCommandExecutionError(code, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}
