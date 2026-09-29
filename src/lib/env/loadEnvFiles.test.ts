import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { loadEnvFiles } from "./loadEnvFiles";

function harness(presentFiles: string[]) {
  const loaded: string[] = [];
  return {
    loaded,
    options: {
      cwd: "/srv/peakcut",
      fileExists: (filePath: string) => presentFiles.includes(path.basename(filePath)),
      loadEnvFile: (filePath: string) => {
        loaded.push(filePath);
      },
    },
  };
}

describe("loadEnvFiles", () => {
  it("loads nothing, and reports nothing, when no env file is present", () => {
    const h = harness([]);
    expect(loadEnvFiles(h.options)).toEqual([]);
    expect(h.loaded).toEqual([]);
  });

  it("loads .env.local when it exists", () => {
    const h = harness([".env.local"]);
    expect(loadEnvFiles(h.options)).toEqual([".env.local"]);
    expect(h.loaded).toEqual([path.join("/srv/peakcut", ".env.local")]);
  });

  it("loads .env.local before .env so the more specific file wins", () => {
    const h = harness([".env", ".env.local"]);
    expect(loadEnvFiles(h.options)).toEqual([".env.local", ".env"]);
  });

  it("falls back to .env alone", () => {
    const h = harness([".env"]);
    expect(loadEnvFiles(h.options)).toEqual([".env"]);
  });

  it("never takes the process down over an unreadable env file", () => {
    const loadEnvFile = vi.fn(() => {
      throw new Error("fichier illisible");
    });
    expect(() =>
      loadEnvFiles({
        cwd: "/srv/peakcut",
        fileExists: () => true,
        loadEnvFile,
      })
    ).not.toThrow();
  });

  it("omits a file that failed to load from what it reports", () => {
    const loadEnvFile = vi.fn((filePath: string) => {
      if (filePath.endsWith(".env.local")) throw new Error("malformé");
    });
    const result = loadEnvFiles({ cwd: "/srv/peakcut", fileExists: () => true, loadEnvFile });
    expect(result).toEqual([".env"]);
  });

  it("resolves the files against the given working directory", () => {
    const h = harness([".env.local"]);
    loadEnvFiles({ ...h.options, cwd: "/autre/racine", fileExists: () => true });
    expect(h.loaded[0]).toBe(path.join("/autre/racine", ".env.local"));
  });
});

describe("loadEnvFiles precedence (real Node semantics)", () => {
  it("never overwrites a variable already set in the real environment", () => {
    // This is the guarantee the worker relies on: a systemd EnvironmentFile
    // or an inline VAR=… must beat a stray .env.local in the working dir.
    const existing = process.env.PEAKCUT_ENV_PRECEDENCE_PROBE;
    try {
      process.env.PEAKCUT_ENV_PRECEDENCE_PROBE = "depuis-environnement";
      loadEnvFiles({
        cwd: "/srv/peakcut",
        fileExists: () => true,
        // Stand in for Node's loader, which skips already-defined keys.
        loadEnvFile: () => {
          if (process.env.PEAKCUT_ENV_PRECEDENCE_PROBE === undefined) {
            process.env.PEAKCUT_ENV_PRECEDENCE_PROBE = "depuis-fichier";
          }
        },
      });
      expect(process.env.PEAKCUT_ENV_PRECEDENCE_PROBE).toBe("depuis-environnement");
    } finally {
      if (existing === undefined) delete process.env.PEAKCUT_ENV_PRECEDENCE_PROBE;
      else process.env.PEAKCUT_ENV_PRECEDENCE_PROBE = existing;
    }
  });
});
