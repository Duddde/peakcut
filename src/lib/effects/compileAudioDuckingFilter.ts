import type { AudioDucking } from "./types";
import { ATTACK_SEC_MAX, ATTACK_SEC_MIN, DUCK_DB_MAX, DUCK_DB_MIN, RELEASE_SEC_MAX, RELEASE_SEC_MIN } from "./types";

/**
 * Compiles a RenderPlan's `audioDucking` into a real ffmpeg
 * `sidechaincompress` filter_complex fragment — but ONLY when a genuine,
 * separate background-audio track is available to duck. PeakCut's export
 * pipeline normally has a single audio stream (the source's own speech);
 * there is nothing to duck against without a second track, so this always
 * reports `applied: false` with an explicit reason in that case — never a
 * silent no-op that pretends to have done something.
 *
 * `sidechaincompress` has no direct "attenuate by N dB while triggered"
 * parameter; `ratio` is derived from the requested duckDb with a documented,
 * simple heuristic (more attenuation → a higher compression ratio) rather
 * than an invented precise translation.
 */

export interface CompileAudioDuckingFilterParams {
  ducking: AudioDucking;
  /** True only when a second, real background-audio input is actually being fed to ffmpeg as [1:a]. */
  hasBackgroundAudio: boolean;
}

export interface CompiledAudioDuckingFilter {
  filterFragment: string | null;
  applied: boolean;
  reason: string;
}

const SIDECHAIN_THRESHOLD = 0.05;
const MIN_RATIO = 2;
const MAX_RATIO = 20;

function ratioFromDuckDb(duckDb: number): number {
  const ratio = 1 + Math.abs(duckDb) / 2;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function compileAudioDuckingFilter(
  params: CompileAudioDuckingFilterParams
): CompiledAudioDuckingFilter {
  const { ducking, hasBackgroundAudio } = params;

  if (!ducking.enabled) {
    return {
      filterFragment: null,
      applied: false,
      reason: "Le ducking audio n'est pas activé par le plan.",
    };
  }
  if (!hasBackgroundAudio) {
    return {
      filterFragment: null,
      applied: false,
      reason:
        "Aucun flux audio de fond séparé n'a été fourni : le ducking reste désactivé (rien à atténuer).",
    };
  }
  if (
    !(ducking.duckDb >= DUCK_DB_MIN && ducking.duckDb <= DUCK_DB_MAX) ||
    !(ducking.attackSec >= ATTACK_SEC_MIN && ducking.attackSec <= ATTACK_SEC_MAX) ||
    !(ducking.releaseSec >= RELEASE_SEC_MIN && ducking.releaseSec <= RELEASE_SEC_MAX)
  ) {
    return {
      filterFragment: null,
      applied: false,
      reason: `Paramètres de ducking hors bornes (duckDb [${DUCK_DB_MIN}, ${DUCK_DB_MAX}], attackSec [${ATTACK_SEC_MIN}, ${ATTACK_SEC_MAX}], releaseSec [${RELEASE_SEC_MIN}, ${RELEASE_SEC_MAX}]).`,
    };
  }

  const ratio = ratioFromDuckDb(ducking.duckDb).toFixed(2);
  const attackMs = Math.round(ducking.attackSec * 1000);
  const releaseMs = Math.round(ducking.releaseSec * 1000);

  const filterFragment =
    `[1:a][0:a]sidechaincompress=threshold=${SIDECHAIN_THRESHOLD}:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}[bgducked];` +
    `[0:a][bgducked]amix=inputs=2:duration=first[aout]`;

  return { filterFragment, applied: true, reason: "Ducking appliqué au flux audio de fond fourni." };
}
