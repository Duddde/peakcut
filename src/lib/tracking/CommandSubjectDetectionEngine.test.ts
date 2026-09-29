import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CommandSubjectDetectionEngine,
  TrackerCommandExecutionError,
  TrackerCommandInvalidOutputError,
  TrackerCommandNotConfiguredError,
  TrackerCommandTimeoutError,
} from "./CommandSubjectDetectionEngine";

const BASE_INPUT = { mediaPath: "/tmp/does-not-matter.mp4", sourceWidth: 1920, sourceHeight: 1080, durationSec: 4 };

async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, `#!/usr/bin/env node\n${body}\n`, "utf-8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("CommandSubjectDetectionEngine (real subprocess)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-tracker-cmd-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws TrackerCommandNotConfiguredError when no command is configured (option or env)", async () => {
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", "");
    const engine = new CommandSubjectDetectionEngine();
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandNotConfiguredError);
  });

  it("runs the configured local command with controlled argv and parses its JSON output", async () => {
    const script = await writeScript(
      dir,
      "success.js",
      `
      const args = process.argv.slice(2);
      console.log(JSON.stringify([
        { tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.4, score: 0.9, trackId: "p1" },
      ]));
      `
    );
    const engine = new CommandSubjectDetectionEngine({ command: script });
    const result = await engine.detect(BASE_INPUT);
    expect(result).toEqual([{ tSec: 0, x: 0.4, y: 0.3, width: 0.2, height: 0.4, score: 0.9, trackId: "p1" }]);
  });

  it("passes mediaPath/sourceWidth/sourceHeight/durationSec as plain argv, no shell", async () => {
    const expectedArgv = JSON.stringify([
      BASE_INPUT.mediaPath,
      String(BASE_INPUT.sourceWidth),
      String(BASE_INPUT.sourceHeight),
      String(BASE_INPUT.durationSec),
    ]);
    const script = await writeScript(
      dir,
      "echo-argv.js",
      `
      const args = process.argv.slice(2);
      const ok = JSON.stringify(args) === ${JSON.stringify(expectedArgv)};
      console.log(JSON.stringify(ok ? [] : [{ tSec: 0, x: 0, y: 0, width: 0.1, height: 0.1, score: 0.5 }]));
      `
    );
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).resolves.toEqual([]);
  });

  it("throws TrackerCommandTimeoutError when the command runs past the configured timeout", async () => {
    const script = await writeScript(dir, "slow.js", `setTimeout(() => {}, 5000);`);
    const engine = new CommandSubjectDetectionEngine({ command: script, timeoutMs: 100 });
    const start = Date.now();
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandTimeoutError);
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);

  it("throws TrackerCommandExecutionError when the command exits non-zero", async () => {
    const script = await writeScript(dir, "fail.js", `console.error("boom"); process.exit(1);`);
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandExecutionError);
  });

  it("throws TrackerCommandInvalidOutputError for non-JSON stdout", async () => {
    const script = await writeScript(dir, "garbage.js", `console.log("not json at all");`);
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandInvalidOutputError);
  });

  it("throws TrackerCommandInvalidOutputError when JSON is valid but not an array", async () => {
    const script = await writeScript(dir, "not-array.js", `console.log(JSON.stringify({ oops: true }));`);
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandInvalidOutputError);
  });

  it("throws TrackerCommandInvalidOutputError when an entry violates the schema (score out of range)", async () => {
    const script = await writeScript(
      dir,
      "bad-score.js",
      `console.log(JSON.stringify([{ tSec: 0, x: 0, y: 0, width: 0.1, height: 0.1, score: 5 }]));`
    );
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandInvalidOutputError);
  });

  it("throws TrackerCommandInvalidOutputError when a required field is missing", async () => {
    const script = await writeScript(
      dir,
      "missing-field.js",
      `console.log(JSON.stringify([{ tSec: 0, x: 0, y: 0, width: 0.1, score: 0.5 }]));`
    );
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).rejects.toBeInstanceOf(TrackerCommandInvalidOutputError);
  });

  it("accepts an empty array (a legitimate 'nothing detected' outcome)", async () => {
    const script = await writeScript(dir, "empty.js", `console.log(JSON.stringify([]));`);
    const engine = new CommandSubjectDetectionEngine({ command: script });
    await expect(engine.detect(BASE_INPUT)).resolves.toEqual([]);
  });

  it("reads the command from PEAKCUT_TRACKER_COMMAND when no explicit option is given", async () => {
    const script = await writeScript(dir, "from-env.js", `console.log(JSON.stringify([]));`);
    vi.stubEnv("PEAKCUT_TRACKER_COMMAND", script);
    const engine = new CommandSubjectDetectionEngine();
    await expect(engine.detect(BASE_INPUT)).resolves.toEqual([]);
  });

  it("never forwards the parent process's other environment variables (no secret leakage) to the spawned command", async () => {
    vi.stubEnv("PEAKCUT_SUPER_SECRET_TEST_VALUE", "leaked-secret-should-not-appear");
    const script = await writeScript(
      dir,
      "env-check.js",
      `console.log(JSON.stringify([{ tSec: 0, x: 0, y: 0, width: 0.1, height: 0.1, score: (process.env.PEAKCUT_SUPER_SECRET_TEST_VALUE ? 1 : 0) }]));`
    );
    const engine = new CommandSubjectDetectionEngine({ command: script });
    const result = await engine.detect(BASE_INPUT);
    expect(result[0].score).toBe(0);
  });
});
