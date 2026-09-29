import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads the project's .env files into process.env for plain Node entry
 * points (the job worker, one-off scripts). The Next.js server does this
 * on its own; a `tsx scripts/…` process does not, which is why the worker
 * used to die on a missing PEAKCUT_DB_PATH while the web app beside it ran
 * fine off the very same .env.local.
 *
 * Precedence, from Node's own `process.loadEnvFile` semantics: a variable
 * already present in the real environment is never overwritten. A systemd
 * `EnvironmentFile=`, a CI secret, or an inline `VAR=… npm run worker`
 * therefore always wins over a file that happens to be sitting in the
 * working directory. Files are loaded most-specific first for the same
 * reason.
 *
 * Nothing here is required: a deployment that injects real environment
 * variables (the documented production setup) loads no file at all and is
 * unaffected.
 */

/** Most specific first; the first file to define a variable wins. */
const ENV_FILENAMES = [".env.local", ".env"];

export interface LoadEnvFilesOptions {
  cwd?: string;
  /** Injected in tests. Defaults to Node's built-in loader. */
  loadEnvFile?: (filePath: string) => void;
  fileExists?: (filePath: string) => boolean;
}

/** Returns the files actually loaded, in order, so the caller can report them. */
export function loadEnvFiles(options: LoadEnvFilesOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const fileExists = options.fileExists ?? existsSync;
  const load = options.loadEnvFile ?? ((filePath: string) => process.loadEnvFile(filePath));

  const loaded: string[] = [];
  for (const filename of ENV_FILENAMES) {
    const filePath = path.join(cwd, filename);
    if (!fileExists(filePath)) continue;
    try {
      load(filePath);
      loaded.push(filename);
    } catch {
      // A malformed or unreadable .env file must not take the worker down:
      // the variables it would have set may well already come from the real
      // environment, and getDbConfig/getAuthSecret report anything genuinely
      // missing with a far more precise message than a parse error here.
    }
  }
  return loaded;
}
