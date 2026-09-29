/**
 * Independent, defense-in-depth validation of a compiled ffmpeg filtergraph
 * string, run *after* compileZoomFilter/buildAssSubtitles produce it and
 * *before* it is ever handed to ffmpeg. This exists so a bug in the
 * compiler (or a future, less-trusted plan source) can never smuggle an
 * extreme numeric value or an unexpected character into the process we
 * spawn — even though ffmpeg is invoked via execve-style argv (spawn with
 * an args array, never a shell), so classic shell injection is not the
 * threat model here; the threat is a malformed or absurd *filter
 * expression* that could crash ffmpeg, run for an unbounded time, or (in a
 * future refactor that adds a shell somewhere) become dangerous.
 */

export interface FilterGraphValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_FILTER_GRAPH_LENGTH = 8000;

// Everything a legitimate PeakCut filtergraph ever needs: filter/function
// names, numbers, the eval operators/vars we emit, path characters for the
// quoted ASS path, and separators. Notably excludes: ; | & $ ` ! < > \n \r
// and unescaped double quotes.
const ALLOWED_CHARACTERS_PATTERN = /^[a-zA-Z0-9_./:=,;'\-\s()[\]*+]*$/;

const MAX_ABS_NUMBER = 100000;

function extractNumbers(filterGraph: string): number[] {
  const matches = filterGraph.match(/-?\d+(\.\d+)?(e-?\d+)?/gi) ?? [];
  return matches.map(Number);
}

export function validateFilterGraph(filterGraph: string): FilterGraphValidationResult {
  const errors: string[] = [];

  if (filterGraph.length === 0) {
    errors.push("le filtergraph est vide.");
  }
  if (filterGraph.length > MAX_FILTER_GRAPH_LENGTH) {
    errors.push(`le filtergraph dépasse la longueur maximale autorisée (${MAX_FILTER_GRAPH_LENGTH} caractères).`);
  }
  if (/[\n\r]/.test(filterGraph)) {
    errors.push("le filtergraph ne doit pas contenir de retour à la ligne.");
  }
  if (!ALLOWED_CHARACTERS_PATTERN.test(filterGraph)) {
    errors.push("le filtergraph contient des caractères non autorisés.");
  }
  // ';' is legitimate ffmpeg filter_complex chain-separator syntax, not a shell
  // metacharacter here (ffmpeg is always spawned via argv, never a shell) — it is
  // intentionally excluded from this list. Everything below genuinely has no
  // place in an ffmpeg filter expression.
  for (const dangerous of ["|", "&", "$(", "`", "<", ">"]) {
    if (filterGraph.includes(dangerous)) {
      errors.push(`le filtergraph contient une séquence dangereuse : "${dangerous}".`);
    }
  }

  for (const n of extractNumbers(filterGraph)) {
    if (!Number.isFinite(n)) {
      errors.push(`valeur numérique non finie détectée dans le filtergraph : ${n}.`);
    } else if (Math.abs(n) > MAX_ABS_NUMBER) {
      errors.push(`valeur numérique extrême détectée dans le filtergraph : ${n}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}
