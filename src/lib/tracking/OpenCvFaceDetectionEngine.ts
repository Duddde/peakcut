import { spawn } from "node:child_process";
import path from "node:path";
import type { DetectedBoundingBox, SubjectDetectionEngine, SubjectDetectionInput } from "./types";

/**
 * Real, optional face-detection engine backed by a local Python + OpenCV
 * script (scripts/vision/track_faces.py), using OpenCV's built-in Haar
 * frontal-face cascade. PeakCut ships no ML weights of its own — this is
 * the one concrete, on-device detector available when a Python venv with
 * opencv-python-headless is installed (see requirements-vision.txt).
 *
 * Invocation is always `spawn(pythonBinary, [scriptPath, mediaPath])` —
 * controlled argv, no shell, minimal inherited environment (just PATH, so
 * no PeakCut secret ever reaches the Python process).
 */

export class OpenCvEngineTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Le script de détection OpenCV a dépassé le délai d'attente (${timeoutMs}ms).`);
    this.name = "OpenCvEngineTimeoutError";
  }
}

export class OpenCvEngineExecutionError extends Error {
  constructor(reason: string) {
    super(`Échec du script de détection OpenCV : ${reason.slice(-1000)}`);
    this.name = "OpenCvEngineExecutionError";
  }
}

export class OpenCvEngineInvalidOutputError extends Error {
  constructor(reason: string) {
    super(`Sortie invalide du script de détection OpenCV : ${reason}`);
    this.name = "OpenCvEngineInvalidOutputError";
  }
}

export interface OpenCvFaceDetectionEngineOptions {
  /** Defaults to "python3". */
  pythonBinary?: string;
  /** Defaults to scripts/vision/track_faces.py relative to the project root. */
  scriptPath?: string;
  timeoutMs?: number;
  availabilityTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Pure parser/validator for track_faces.py's stdout — independently unit
 * testable without ever spawning a process. Accepts either the documented
 * success shape or the documented `{"error": "..."}` shape; anything else
 * is rejected as an invalid-output error.
 */
export function parseOpenCvOutput(stdout: string): DetectedBoundingBox[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OpenCvEngineInvalidOutputError("la sortie standard n'est pas un JSON valide.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new OpenCvEngineInvalidOutputError("la sortie JSON doit être un objet.");
  }
  const body = parsed as Record<string, unknown>;

  if (typeof body.error === "string") {
    throw new OpenCvEngineExecutionError(body.error);
  }

  const source = body.source;
  if (typeof source !== "object" || source === null) {
    throw new OpenCvEngineInvalidOutputError("le champ source est manquant.");
  }
  const s = source as Record<string, unknown>;
  if (!isFiniteNumber(s.width) || !isFiniteNumber(s.height) || !isFiniteNumber(s.duration_sec)) {
    throw new OpenCvEngineInvalidOutputError("source.width/height/duration_sec invalides.");
  }

  if (!Array.isArray(body.detections)) {
    throw new OpenCvEngineInvalidOutputError("le champ detections doit être un tableau.");
  }

  return body.detections.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new OpenCvEngineInvalidOutputError(`detections[${index}] doit être un objet.`);
    }
    const d = raw as Record<string, unknown>;
    if (
      !isFiniteNumber(d.tSec) ||
      d.tSec < 0 ||
      !isFiniteNumber(d.x) ||
      !isFiniteNumber(d.y) ||
      !isFiniteNumber(d.width) ||
      !isFiniteNumber(d.height) ||
      d.width <= 0 ||
      d.height <= 0 ||
      !isFiniteNumber(d.confidence) ||
      d.confidence < 0 ||
      d.confidence > 1
    ) {
      throw new OpenCvEngineInvalidOutputError(`detections[${index}] ne respecte pas le schéma attendu.`);
    }
    if (d.kind !== "face") {
      throw new OpenCvEngineInvalidOutputError(`detections[${index}].kind doit valoir "face".`);
    }
    return {
      tSec: d.tSec,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      score: d.confidence,
    };
  });
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
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
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export class OpenCvFaceDetectionEngine implements SubjectDetectionEngine {
  readonly id = "opencv-face-detector";

  private readonly pythonBinary: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly availabilityTimeoutMs: number;

  constructor(options: OpenCvFaceDetectionEngineOptions = {}) {
    this.pythonBinary = options.pythonBinary ?? process.env.PEAKCUT_PYTHON_BINARY ?? "python3";
    this.scriptPath = options.scriptPath ?? path.join(process.cwd(), "scripts", "vision", "track_faces.py");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;
  }

  /** Cheap real check: can this Python + OpenCV actually run? Never throws. */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await runProcess(this.pythonBinary, ["-c", "import cv2"], this.availabilityTimeoutMs);
      return !result.timedOut && result.code === 0;
    } catch {
      return false;
    }
  }

  async detect(input: SubjectDetectionInput): Promise<DetectedBoundingBox[]> {
    const { stdout, stderr, code, timedOut } = await runProcess(
      this.pythonBinary,
      [this.scriptPath, input.mediaPath],
      this.timeoutMs
    );

    if (timedOut) {
      throw new OpenCvEngineTimeoutError(this.timeoutMs);
    }

    try {
      return parseOpenCvOutput(stdout);
    } catch (err) {
      if (err instanceof OpenCvEngineInvalidOutputError && code !== 0) {
        throw new OpenCvEngineExecutionError(stderr || `code de sortie ${code}`);
      }
      throw err;
    }
  }
}
