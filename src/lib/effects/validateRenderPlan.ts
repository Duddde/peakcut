import { isValidAssetId } from "@/lib/assets/imageAsset";
import {
  ATTACK_SEC_MAX,
  ATTACK_SEC_MIN,
  DUCK_DB_MAX,
  DUCK_DB_MIN,
  FONT_SIZE_SCALE_MAX,
  FONT_SIZE_SCALE_MIN,
  FRAMING_LABEL_MAX_LENGTH,
  FRAMING_MIN_SIZE,
  FRAMING_SHOT_SOURCES,
  FRAMING_TRANSITION_SEC_MAX,
  FRAMING_TRANSITION_SEC_MIN,
  HEX_COLOR_PATTERN,
  INTENSITY_MAX,
  INTENSITY_MIN,
  MARGIN_SCALE_MAX,
  MARGIN_SCALE_MIN,
  MAX_FRAMING_SHOTS_PER_PLAN,
  MAX_OVERLAYS_PER_PLAN,
  MAX_PERSPECTIVE_MOVES_PER_PLAN,
  MIN_CUT_DURATION_SEC,
  MIN_FRAMING_SHOT_DURATION_SEC,
  MIN_OVERLAY_DURATION_SEC,
  MIN_PERSPECTIVE_MOVE_DURATION_SEC,
  OVERLAY_FADE_SEC_MAX,
  OVERLAY_FADE_SEC_MIN,
  OVERLAY_MIN_SIZE,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  PERSPECTIVE_AMOUNT_MAX,
  PERSPECTIVE_AMOUNT_MIN,
  PERSPECTIVE_DIRECTIONS,
  PERSPECTIVE_PROFILES,
  RELEASE_SEC_MAX,
  RELEASE_SEC_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  perspectiveAxisOf,
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

/**
 * Overlays, checked against the same bounds the builder respects — plus
 * two rules the others don't need. The image must sit inside the frame,
 * because ffmpeg's `overlay` happily places a picture half outside it and
 * the result is a clip nobody asked for. And the asset id must look like
 * an id: it is the one field of a plan that the render turns into a
 * filesystem lookup, so a value shaped like anything else is refused here
 * rather than resolved there.
 */
function validateOverlays(
  plan: RenderPlan,
  minCutStart: number,
  maxCutEnd: number,
  errors: string[]
): void {
  if (plan.overlays.length > MAX_OVERLAYS_PER_PLAN) {
    errors.push(`trop d'illustrations : ${plan.overlays.length} (maximum ${MAX_OVERLAYS_PER_PLAN}).`);
  }

  const seenIds = new Set<string>();
  for (const overlay of plan.overlays) {
    const at = `illustration "${overlay.id}"`;

    if (seenIds.has(overlay.id)) {
      errors.push(`${at} : identifiant en double.`);
    }
    seenIds.add(overlay.id);

    if (!isValidAssetId(overlay.assetId)) {
      errors.push(`${at} : assetId invalide ("${overlay.assetId}").`);
    }

    const duration = overlay.endSec - overlay.startSec;
    if (overlay.startSec < 0) {
      errors.push(`${at} : startSec négatif (${overlay.startSec}).`);
    }
    if (!(duration >= MIN_OVERLAY_DURATION_SEC)) {
      errors.push(`${at} : durée trop courte (< ${MIN_OVERLAY_DURATION_SEC}s) : ${overlay.startSec}s–${overlay.endSec}s.`);
    }
    if (overlay.startSec < minCutStart || overlay.endSec > maxCutEnd) {
      errors.push(`${at} : hors de la plage des coupes (${overlay.startSec}s–${overlay.endSec}s).`);
    }

    if (!(overlay.opacity >= OVERLAY_OPACITY_MIN && overlay.opacity <= OVERLAY_OPACITY_MAX)) {
      errors.push(`${at} : opacité hors bornes [${OVERLAY_OPACITY_MIN}, ${OVERLAY_OPACITY_MAX}] : ${overlay.opacity}.`);
    }
    if (!(overlay.fadeSec >= OVERLAY_FADE_SEC_MIN && overlay.fadeSec <= OVERLAY_FADE_SEC_MAX)) {
      errors.push(`${at} : fondu hors bornes [${OVERLAY_FADE_SEC_MIN}, ${OVERLAY_FADE_SEC_MAX}] : ${overlay.fadeSec}.`);
    }
    if (duration > 0 && overlay.fadeSec * 2 > duration) {
      errors.push(`${at} : le fondu (${overlay.fadeSec}s de chaque côté) dépasse la durée de l'illustration (${duration}s).`);
    }

    const rect = overlay.rect;
    if (!(rect.width >= OVERLAY_MIN_SIZE) || !(rect.height >= OVERLAY_MIN_SIZE)) {
      errors.push(`${at} : trop petite pour être visible (minimum ${OVERLAY_MIN_SIZE} du cadre).`);
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      errors.push(`${at} : sort du cadre (${JSON.stringify(rect)}).`);
    }
  }
}

/**
 * Framing shots, checked against the same bounds the detector and the
 * studio respect.
 *
 * Two rules here are not about taste. Shots must not overlap, because
 * the compiled crop expression resolves time to exactly one rectangle
 * and an overlap would make which one win an accident of branch order.
 * And a shot's rectangle must fit inside the source frame: ffmpeg's
 * `crop` clamps a rectangle that falls outside, so an out-of-frame shot
 * would render a frame nobody chose instead of failing.
 */
function validateFraming(
  plan: RenderPlan,
  minCutStart: number,
  maxCutEnd: number,
  errors: string[]
): void {
  if (plan.framing.length > MAX_FRAMING_SHOTS_PER_PLAN) {
    errors.push(`trop de plans de cadrage : ${plan.framing.length} (maximum ${MAX_FRAMING_SHOTS_PER_PLAN}).`);
  }

  const seenIds = new Set<string>();
  for (const shot of plan.framing) {
    const at = `plan de cadrage "${shot.id}"`;

    if (seenIds.has(shot.id)) {
      errors.push(`${at} : identifiant en double.`);
    }
    seenIds.add(shot.id);

    if (!FRAMING_SHOT_SOURCES.includes(shot.source)) {
      errors.push(`${at} : source inconnue ("${shot.source}").`);
    }
    if (shot.label !== null && shot.label.length > FRAMING_LABEL_MAX_LENGTH) {
      errors.push(`${at} : libellé trop long (maximum ${FRAMING_LABEL_MAX_LENGTH} caractères).`);
    }

    const duration = shot.endSec - shot.startSec;
    if (shot.startSec < 0) {
      errors.push(`${at} : startSec négatif (${shot.startSec}).`);
    }
    if (!(duration >= MIN_FRAMING_SHOT_DURATION_SEC)) {
      errors.push(
        `${at} : durée trop courte (< ${MIN_FRAMING_SHOT_DURATION_SEC}s) : ${shot.startSec}s–${shot.endSec}s.`
      );
    }
    if (shot.startSec < minCutStart || shot.endSec > maxCutEnd) {
      errors.push(`${at} : hors de la plage des coupes (${shot.startSec}s–${shot.endSec}s).`);
    }

    if (
      !(shot.transitionSec >= FRAMING_TRANSITION_SEC_MIN && shot.transitionSec <= FRAMING_TRANSITION_SEC_MAX)
    ) {
      errors.push(
        `${at} : transition hors bornes [${FRAMING_TRANSITION_SEC_MIN}, ${FRAMING_TRANSITION_SEC_MAX}] : ${shot.transitionSec}.`
      );
    }
    if (duration > 0 && shot.transitionSec > duration) {
      errors.push(`${at} : la transition (${shot.transitionSec}s) dépasse la durée du plan (${duration}s).`);
    }

    const rect = shot.rect;
    if (!(rect.width >= FRAMING_MIN_SIZE) || !(rect.height >= FRAMING_MIN_SIZE)) {
      errors.push(`${at} : fenêtre de cadrage trop petite (minimum ${FRAMING_MIN_SIZE} de la source).`);
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      errors.push(`${at} : sort du cadre source (${JSON.stringify(rect)}).`);
    }
  }

  const sorted = [...plan.framing].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startSec < sorted[i - 1].endSec) {
      errors.push(
        `plans de cadrage qui se chevauchent : "${sorted[i - 1].id}" (${sorted[i - 1].startSec}s–${sorted[i - 1].endSec}s) / "${sorted[i].id}" (${sorted[i].startSec}s–${sorted[i].endSec}s).`
      );
    }
  }
}

/**
 * 3D moves, checked against the bounds the builder and the studio
 * respect.
 *
 * The overlap rule is the one worth reading. Two moves on the same axis
 * cannot overlap, because the compiled tilt expression resolves a frame
 * to exactly one value and an overlap would make which move wins an
 * accident of branch order. Two moves on *different* axes may overlap on
 * purpose: a horizontal and a vertical tilt running together compose
 * into a diagonal one, which is a camera move, not a conflict.
 */
function validatePerspectiveMoves(
  plan: RenderPlan,
  minCutStart: number,
  maxCutEnd: number,
  errors: string[]
): void {
  if (plan.perspectiveMoves.length > MAX_PERSPECTIVE_MOVES_PER_PLAN) {
    errors.push(
      `trop d'effets 3D : ${plan.perspectiveMoves.length} (maximum ${MAX_PERSPECTIVE_MOVES_PER_PLAN}).`
    );
  }

  const seenIds = new Set<string>();
  for (const move of plan.perspectiveMoves) {
    const at = `effet 3D "${move.id}"`;

    if (seenIds.has(move.id)) {
      errors.push(`${at} : identifiant en double.`);
    }
    seenIds.add(move.id);

    if (!PERSPECTIVE_DIRECTIONS.includes(move.direction)) {
      errors.push(`${at} : direction inconnue ("${move.direction}").`);
    }
    if (!PERSPECTIVE_PROFILES.includes(move.profile)) {
      errors.push(`${at} : profil inconnu ("${move.profile}").`);
    }
    if (!(move.amount >= PERSPECTIVE_AMOUNT_MIN && move.amount <= PERSPECTIVE_AMOUNT_MAX)) {
      errors.push(
        `${at} : intensité hors bornes [${PERSPECTIVE_AMOUNT_MIN}, ${PERSPECTIVE_AMOUNT_MAX}] : ${move.amount}.`
      );
    }

    const duration = move.endSec - move.startSec;
    if (move.startSec < 0) {
      errors.push(`${at} : startSec négatif (${move.startSec}).`);
    }
    if (!(duration >= MIN_PERSPECTIVE_MOVE_DURATION_SEC)) {
      errors.push(
        `${at} : durée trop courte (< ${MIN_PERSPECTIVE_MOVE_DURATION_SEC}s) : ${move.startSec}s–${move.endSec}s.`
      );
    }
    if (move.startSec < minCutStart || move.endSec > maxCutEnd) {
      errors.push(`${at} : hors de la plage des coupes (${move.startSec}s–${move.endSec}s).`);
    }
  }

  for (const axis of ["horizontal", "vertical"] as const) {
    const onAxis = plan.perspectiveMoves
      .filter((move) => perspectiveAxisOf(move.direction) === axis)
      .sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < onAxis.length; i++) {
      if (onAxis[i].startSec < onAxis[i - 1].endSec) {
        errors.push(
          `effets 3D qui se chevauchent sur le même axe : "${onAxis[i - 1].id}" (${onAxis[i - 1].startSec}s–${onAxis[i - 1].endSec}s) / "${onAxis[i].id}" (${onAxis[i].startSec}s–${onAxis[i].endSec}s).`
        );
      }
    }
  }
}

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

  validateOverlays(plan, minCutStart, maxCutEnd, errors);
  validateFraming(plan, minCutStart, maxCutEnd, errors);
  validatePerspectiveMoves(plan, minCutStart, maxCutEnd, errors);

  if (plan.safeZones.length === 0) {
    errors.push("safeZones ne doit pas être vide.");
  }

  if (plan.limitations.length === 0) {
    errors.push("limitations ne doit pas être vide : un plan doit toujours documenter ce qu'il n'applique pas réellement.");
  }

  return { ok: errors.length === 0, errors };
}
