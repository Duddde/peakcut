import { spawn } from "node:child_process";

/**
 * Minimal line-oriented subprocess runner, injected into the downloader so
 * its logic (argument building, metadata gating, error mapping, output
 * file resolution) can be tested without spawning anything real. The
 * default implementation is a genuine `spawn` — PeakCut never fakes a
 * download.
 *
 * Arguments are always passed as an array and never interpolated into a
 * shell string: a URL reaching here is attacker-influenced, and `shell`
 * is deliberately never enabled.
 */

export interface ProcessRunOptions {
  /** Called once per complete stdout line, without the trailing newline. */
  onStdoutLine?: (line: string) => void;
  /** Called once per complete stderr line, without the trailing newline. */
  onStderrLine?: (line: string) => void;
  /** Cooperative cancellation; the child is killed and `cancelled` is set on the result. */
  signal?: AbortSignal;
  /** Wall-clock limit. On expiry the child is killed and `timedOut` is set on the result. */
  timeoutMs?: number;
  /**
   * Hard cap on retained stdout/stderr text, so a chatty child can never
   * exhaust memory. When the cap is hit, `truncated` is set on the result:
   * a caller that parses stdout MUST check it rather than parse a prefix.
   */
  maxCapturedChars?: number;
}

export interface ProcessRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** True when stdout or stderr exceeded maxCapturedChars and what's here is only a prefix. */
  truncated: boolean;
}

/**
 * The child could not be started at all, as opposed to started and failed.
 * Covers a missing binary (ENOENT), one that cannot be executed (EACCES,
 * ENOEXEC) and, on Windows, a `.cmd`/`.bat` shim, which `spawn` refuses
 * with EINVAL when no shell is used — a distinction worth keeping, since
 * "install yt-dlp" is the wrong advice when the binary is right there but
 * shipped as a batch shim.
 */
export class ProcessLaunchError extends Error {
  readonly command: string;
  readonly errnoCode: string | null;

  constructor(command: string, errnoCode: string | null) {
    super(
      errnoCode === "ENOENT"
        ? `Exécutable introuvable : "${command}".`
        : `Exécutable non lançable : "${command}" (${errnoCode ?? "erreur inconnue"}).`
    );
    this.name = "ProcessLaunchError";
    this.command = command;
    this.errnoCode = errnoCode ?? null;
  }
}

/** Errno codes that mean "this command never ran", not "it ran and failed". */
const LAUNCH_FAILURE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EINVAL"]);

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: ProcessRunOptions
) => Promise<ProcessRunResult>;

const DEFAULT_MAX_CAPTURED_CHARS = 64 * 1024;

/** Emits complete lines to `onLine` and accumulates a bounded copy of the raw text. */
function createLineAccumulator(
  onLine: ((line: string) => void) | undefined,
  maxCapturedChars: number
) {
  let pending = "";
  let captured = "";
  let truncated = false;

  return {
    get truncated() {
      return truncated;
    },
    push(chunk: string) {
      if (captured.length + chunk.length > maxCapturedChars) truncated = true;
      if (captured.length < maxCapturedChars) {
        captured += chunk.slice(0, maxCapturedChars - captured.length);
      }
      // yt-dlp redraws its progress bar with \r; treat it as a line break
      // so in-place updates surface as individual progress events.
      pending += chunk.replace(/\r(?!\n)/g, "\n");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (onLine) {
        for (const line of lines) onLine(line);
      }
    },
    flush(): string {
      if (pending && onLine) onLine(pending);
      pending = "";
      return captured;
    },
  };
}

export const runProcess: ProcessRunner = (command, args, options = {}) => {
  const maxCapturedChars = options.maxCapturedChars ?? DEFAULT_MAX_CAPTURED_CHARS;

  return new Promise<ProcessRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true, truncated: false });
      return;
    }

    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch (err) {
      const errnoCode = (err as NodeJS.ErrnoException).code;
      reject(
        errnoCode && LAUNCH_FAILURE_CODES.has(errnoCode)
          ? new ProcessLaunchError(command, errnoCode)
          : err
      );
      return;
    }

    const stdout = createLineAccumulator(options.onStdoutLine, maxCapturedChars);
    const stderr = createLineAccumulator(options.onStderrLine, maxCapturedChars);

    let timedOut = false;
    let cancelled = false;
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.flush();
      stderr.flush();
      reject(err.code && LAUNCH_FAILURE_CODES.has(err.code) ? new ProcessLaunchError(command, err.code) : err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutText = stdout.flush();
      const stderrText = stderr.flush();
      resolve({
        code,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
};
