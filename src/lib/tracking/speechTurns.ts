import type { TranscriptWord } from "@/lib/domain/types";

/**
 * Who speaks when, read off the transcript's own diarization.
 *
 * This is the audio half of active-speaker framing. The visual half knows
 * where the faces are; only the transcript knows that a different person
 * started talking at 12.4 s — and it knows it because the provider
 * labelled it (AssemblyAI with `speaker_labels`), not because anything
 * here guessed.
 *
 * Words the provider left unlabelled end the current turn instead of
 * extending it: attributing an unlabelled word to whoever spoke last
 * would quietly turn one provider's uncertainty into a frame on the
 * wrong face.
 */

export interface SpeechTurn {
  speaker: string;
  /** Absolute seconds in the source, like the words themselves. */
  startSec: number;
  endSec: number;
}

export function speechTurnsFromWords(words: TranscriptWord[]): SpeechTurn[] {
  const ordered = [...words].sort((a, b) => a.startSec - b.startSec);
  const turns: SpeechTurn[] = [];
  let current: SpeechTurn | null = null;

  for (const word of ordered) {
    const speaker = typeof word.speaker === "string" ? word.speaker.trim() : "";
    if (speaker.length === 0) {
      current = null;
      continue;
    }

    const endSec = Math.max(word.endSec, word.startSec);
    if (current && current.speaker === speaker) {
      current.endSec = Math.max(current.endSec, endSec);
      continue;
    }

    current = { speaker, startSec: word.startSec, endSec };
    turns.push(current);
  }

  return turns;
}

/** The distinct speakers of a turn list, in order of first appearance. */
export function speakersOf(turns: SpeechTurn[]): string[] {
  const seen: string[] = [];
  for (const turn of turns) {
    if (!seen.includes(turn.speaker)) seen.push(turn.speaker);
  }
  return seen;
}

/** Turns clipped to a window, in that window's own time base (0 = windowStartSec). */
export function turnsWithin(turns: SpeechTurn[], windowStartSec: number, windowEndSec: number): SpeechTurn[] {
  const clipped: SpeechTurn[] = [];
  for (const turn of turns) {
    const startSec = Math.max(turn.startSec, windowStartSec);
    const endSec = Math.min(turn.endSec, windowEndSec);
    if (endSec <= startSec) continue;
    clipped.push({
      speaker: turn.speaker,
      startSec: startSec - windowStartSec,
      endSec: endSec - windowStartSec,
    });
  }
  return clipped;
}
