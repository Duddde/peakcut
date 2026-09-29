import {
  ATTACK_SEC_MAX,
  ATTACK_SEC_MIN,
  DUCK_DB_MAX,
  DUCK_DB_MIN,
  FONT_SIZE_SCALE_MAX,
  FONT_SIZE_SCALE_MIN,
  HEX_COLOR_PATTERN,
  INTENSITY_MAX,
  INTENSITY_MIN,
  MARGIN_SCALE_MAX,
  MARGIN_SCALE_MIN,
  MIN_CUT_DURATION_SEC,
  RELEASE_SEC_MAX,
  RELEASE_SEC_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  type RenderPlan,
} from "./types";

export interface RenderPlanValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Independently re-checks every bound buildRenderPlan is supposed to
 * respect. This exists so a RenderPlan arriving over the network (from a
 * client, or a future non-deterministic template) can never push an
 * extreme, jarring effect into the real export — the export route must
 * call this and refuse to render anything that fails.
 */
export function validateRenderPlan(plan: RenderPlan): RenderPlanValidationResult {
  const errors: string[] = [];

  if (!(plan.intensity >= INTENSITY_MIN && plan.intensity <= INTENSITY_MAX)) {
    errors.push(`intensité hors bornes [${INTENSITY_MIN}, ${INTENSITY_MAX}] : ${plan.intensity}.`);
  }

  for (const kf of plan.zoomKeyframes) {
    if (!(kf.scale >= ZOOM_SCALE_MIN && kf.scale <= ZOOM_SCALE_MAX)) {
      errors.push(`échelle de zoom hors bornes [${ZOOM_SCALE_MIN}, ${ZOOM_SCALE_MAX}] à t=${kf.tSec}s : ${kf.scale}.`);
    }
  }

  const style = plan.subtitleStyle;
  if (!(style.fontSizeScale >= FONT_SIZE_SCALE_MIN && style.fontSizeScale <= FONT_SIZE_SCALE_MAX)) {
    errors.push(
      `échelle de police hors bornes [${FONT_SIZE_SCALE_MIN}, ${FONT_SIZE_SCALE_MAX}] : ${style.fontSizeScale}.`
    );
  }
  if (!(style.marginVerticalScale >= MARGIN_SCALE_MIN && style.marginVerticalScale <= MARGIN_SCALE_MAX)) {
    errors.push(
      `échelle de marge hors bornes [${MARGIN_SCALE_MIN}, ${MARGIN_SCALE_MAX}] : ${style.marginVerticalScale}.`
    );
  }
  if (!HEX_COLOR_PATTERN.test(style.primaryColorHex)) {
    errors.push(`couleur de sous-titre invalide : "${style.primaryColorHex}".`);
  }

  if (plan.audioDucking.enabled) {
    const d = plan.audioDucking;
    if (!(d.duckDb >= DUCK_DB_MIN && d.duckDb <= DUCK_DB_MAX)) {
      errors.push(`ducking audio : duckDb hors bornes [${DUCK_DB_MIN}, ${DUCK_DB_MAX}] : ${d.duckDb}.`);
    }
    if (!(d.attackSec >= ATTACK_SEC_MIN && d.attackSec <= ATTACK_SEC_MAX)) {
      errors.push(`ducking audio : attackSec hors bornes [${ATTACK_SEC_MIN}, ${ATTACK_SEC_MAX}] : ${d.attackSec}.`);
    }
    if (!(d.releaseSec >= RELEASE_SEC_MIN && d.releaseSec <= RELEASE_SEC_MAX)) {
      errors.push(
        `ducking audio : releaseSec hors bornes [${RELEASE_SEC_MIN}, ${RELEASE_SEC_MAX}] : ${d.releaseSec}.`
      );
    }
  }

  const sortedCuts = [...plan.cuts].sort((a, b) => a.startSec - b.startSec);
  for (const cut of sortedCuts) {
    if (cut.startSec < 0) {
      errors.push(`coupe invalide : startSec négatif (${cut.startSec}).`);
    }
    if (!(cut.endSec > cut.startSec)) {
      errors.push(`coupe invalide : endSec (${cut.endSec}) doit être supérieur à startSec (${cut.startSec}).`);
    } else if (cut.endSec - cut.startSec < MIN_CUT_DURATION_SEC) {
      errors.push(`coupe trop courte (< ${MIN_CUT_DURATION_SEC}s) : ${cut.startSec}s–${cut.endSec}s.`);
    }
  }
  for (let i = 1; i < sortedCuts.length; i++) {
    if (sortedCuts[i].startSec < sortedCuts[i - 1].endSec) {
      errors.push(`coupes qui se chevauchent (overlap) : ${JSON.stringify(sortedCuts[i - 1])} / ${JSON.stringify(sortedCuts[i])}.`);
    }
  }

  const maxCutEnd = sortedCuts.length > 0 ? Math.max(...sortedCuts.map((c) => c.endSec)) : 0;
  const minCutStart = sortedCuts.length > 0 ? Math.min(...sortedCuts.map((c) => c.startSec)) : 0;
  for (const kf of plan.zoomKeyframes) {
    if (kf.tSec < minCutStart || kf.tSec > maxCutEnd) {
      errors.push(`image clé de zoom à t=${kf.tSec}s hors de la plage des coupes.`);
    }
  }

  if (plan.safeZones.length === 0) {
    errors.push("safeZones ne doit pas être vide.");
  }

  if (plan.limitations.length === 0) {
    errors.push("limitations ne doit pas être vide : un plan doit toujours documenter ce qu'il n'applique pas réellement.");
  }

  return { ok: errors.length === 0, errors };
}
