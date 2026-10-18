import type { SpeechTurn } from "./speechTurns";
import { speakersOf } from "./speechTurns";
import type { SubjectTrack } from "./types";

/**
 * Which face belongs to which voice.
 *
 * The transcript says *when* each speaker talks; the detection says
 * *where* each face is and how much its mouth moved. Put together, the
 * answer is the face whose mouth moved while that voice was talking —
 * which is, in a simplified and honest form, what audio-visual
 * active-speaker detection does. There is no model here and none is
 * claimed: this is a correlation between two real measurements.
 *
 * The important part of this module is everything it refuses to answer.
 * One face, one voice, no measured mouth activity, two faces that moved
 * about equally: in all those cases the right output is "unknown", and
 * the framing stays where it was. A wrong assignment is worse than none —
 * it would frame every clip on the person who is listening.
 */

export interface SpeakerFaceAssignment {
  /** Speaker label → subject track id, only for the ones actually resolved. */
  bySpeaker: Record<string, string>;
  /** Plain-language reasons, in French, for everything left unresolved. */
  reasons: string[];
}

export interface AssignSpeakersToFacesOptions {
  /** Below this many measured samples inside a speaker's turns, the match is not attempted. */
  minSamples?: number;
  /** Mean activity floor: under it, nothing moved enough to call it speech. */
  minMeanActivity?: number;
  /** How much the winner must beat the runner-up by, as a ratio. */
  activityMargin?: number;
}

const DEFAULT_MIN_SAMPLES = 3;
/**
 * Mean absolute inter-frame difference of a mouth region, normalized to
 * [0, 1]. A still face on a static shot sits near zero (sensor noise and
 * compression only); a talking mouth measures an order of magnitude
 * above. The floor is deliberately low — it rules out "nothing moved at
 * all", while the real discrimination is left to the margin below, which
 * compares faces against each other rather than against a constant
 * nobody can calibrate for every camera.
 */
const DEFAULT_MIN_MEAN_ACTIVITY = 0.005;
/**
 * The winner must have moved 30% more than the runner-up. Two faces
 * within that are not distinguishable by this method: a listener nods,
 * smiles and reacts, and on a wide two-shot the difference between
 * nodding and talking is not 30%.
 */
const DEFAULT_ACTIVITY_MARGIN = 1.3;

function isInsideAnyTurn(tSec: number, turns: SpeechTurn[]): boolean {
  return turns.some((turn) => tSec >= turn.startSec && tSec <= turn.endSec);
}

interface Candidate {
  trackId: string;
  meanActivity: number;
  samples: number;
}

function candidatesFor(tracks: SubjectTrack[], turns: SpeechTurn[], minSamples: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (const track of tracks) {
    let sum = 0;
    let samples = 0;
    for (const box of track.boxes) {
      if (typeof box.activity !== "number" || !Number.isFinite(box.activity)) continue;
      if (!isInsideAnyTurn(box.tSec, turns)) continue;
      sum += box.activity;
      samples++;
    }
    if (samples >= minSamples) {
      candidates.push({ trackId: track.id, meanActivity: sum / samples, samples });
    }
  }
  return candidates.sort((a, b) => b.meanActivity - a.meanActivity);
}

export function assignSpeakersToFaces(
  tracks: SubjectTrack[],
  turns: SpeechTurn[],
  options: AssignSpeakersToFacesOptions = {}
): SpeakerFaceAssignment {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minMeanActivity = options.minMeanActivity ?? DEFAULT_MIN_MEAN_ACTIVITY;
  const activityMargin = options.activityMargin ?? DEFAULT_ACTIVITY_MARGIN;

  const speakers = speakersOf(turns);

  if (tracks.length < 2) {
    return {
      bySpeaker: {},
      reasons: [
        "Un seul visage a été détecté : le cadrage n'a pas d'autre sujet vers qui basculer, il reste celui qui suit ce visage.",
      ],
    };
  }
  if (speakers.length < 2) {
    return {
      bySpeaker: {},
      reasons: [
        "Une seule voix est identifiée dans la transcription : rien n'indique de changement d'intervenant à suivre.",
      ],
    };
  }
  const measuresActivity = tracks.some((track) =>
    track.boxes.some((box) => typeof box.activity === "number" && Number.isFinite(box.activity))
  );
  if (!measuresActivity) {
    return {
      bySpeaker: {},
      reasons: [
        "Le moteur de détection ne mesure pas l'activité labiale : impossible de relier une voix à un visage, le cadrage ne suit donc pas le locuteur.",
      ],
    };
  }

  // Best match per speaker, then conflicts resolved by margin: two voices
  // cannot share one face, and the one with the weaker evidence is the
  // one that gives it up.
  interface Claim {
    speaker: string;
    trackId: string;
    margin: number;
  }
  const claims: Claim[] = [];
  const reasons: string[] = [];

  for (const speaker of speakers) {
    const speakerTurns = turns.filter((turn) => turn.speaker === speaker);
    const candidates = candidatesFor(tracks, speakerTurns, minSamples);

    if (candidates.length === 0) {
      reasons.push(
        `Intervenant ${speaker} : pas assez d'images mesurées pendant ses prises de parole pour l'associer à un visage.`
      );
      continue;
    }

    const best = candidates[0];
    if (best.meanActivity < minMeanActivity) {
      reasons.push(
        `Intervenant ${speaker} : aucun visage ne bouge assez pendant ses prises de parole pour être identifié comme le sien.`
      );
      continue;
    }

    const runnerUp = candidates[1];
    const margin = runnerUp && runnerUp.meanActivity > 0 ? best.meanActivity / runnerUp.meanActivity : Infinity;
    if (runnerUp && margin < activityMargin) {
      reasons.push(
        `Intervenant ${speaker} : deux visages bougent autant pendant ses prises de parole, l'association serait un pari.`
      );
      continue;
    }

    claims.push({ speaker, trackId: best.trackId, margin });
  }

  const bySpeaker: Record<string, string> = {};
  const takenBy = new Map<string, Claim>();
  for (const claim of [...claims].sort((a, b) => b.margin - a.margin)) {
    const existing = takenBy.get(claim.trackId);
    if (existing) {
      reasons.push(
        `Intervenant ${claim.speaker} : le visage qui lui correspond le mieux est déjà attribué à l'intervenant ${existing.speaker}, dont l'association est plus nette.`
      );
      continue;
    }
    takenBy.set(claim.trackId, claim);
    bySpeaker[claim.speaker] = claim.trackId;
  }

  return { bySpeaker, reasons };
}
