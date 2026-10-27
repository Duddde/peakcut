import { spawn } from "node:child_process";

/**
 * How loud a stretch of a media file is, moment by moment: the RMS level
 * of its audio over short frames, from 0 (silence) to 1 (full scale).
 *
 * Used to put a cut where the audio is quietest — between two words, in
 * a breath — and to draw the waveform the editor trims clips against. A
 * relative measure on purpose: a show with music or room tone under the
 * voices never goes below an absolute silence threshold, yet the dip
 * between two words is still plain to see.
 */

export const ENVELOPE_SAMPLE_RATE = 8000;

export interface AudioEnvelope {
  /** Absolute time of the first frame, in seconds. */
  startSec: number;
  frameSec: number;
  /** RMS level of each frame, 0..1. */
  levels: number[];
}

/** Injectable in tests, so the code that uses it never spawns ffmpeg. */
export type ReadAudioEnvelope = (
  mediaPath: string,
  startSec: number,
  durationSec: number,
  frameSec: number
) => Promise<AudioEnvelope>;

export const readAudioEnvelope: ReadAudioEnvelope = (mediaPath, startSec, durationSec, frameSec) => {
  const from = Math.max(0, startSec);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        from.toFixed(3),
        "-t",
        Math.max(0.01, durationSec - (from - startSec)).toFixed(3),
        "-i",
        mediaPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(ENVELOPE_SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg (lecture audio) a échoué avec le code ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const samples = Math.floor(pcm.length / 2);
      const perFrame = Math.max(1, Math.round(frameSec * ENVELOPE_SAMPLE_RATE));
      const levels: number[] = [];
      for (let first = 0; first < samples; first += perFrame) {
        const last = Math.min(samples, first + perFrame);
        let sum = 0;
        for (let i = first; i < last; i++) {
          const value = pcm.readInt16LE(i * 2) / 32768;
          sum += value * value;
        }
        levels.push(Math.sqrt(sum / (last - first)));
      }
      resolve({ startSec: from, frameSec: perFrame / ENVELOPE_SAMPLE_RATE, levels });
    });
  });
};

/**
 * The quietest moment of an envelope between two times, in absolute
 * seconds: where a cut does not land on a syllable. The level is smoothed
 * over a few frames first, so a single quiet frame inside a word does not
 * pass for a pause; among moments about as quiet as the quietest, the one
 * nearest `preferSec` wins, so the cut moves no further than it has to.
 *
 * Returns null when the window holds no frame.
 */
export function quietestMoment(envelope: AudioEnvelope, fromSec: number, toSec: number, preferSec: number): number | null {
  const { levels, frameSec } = envelope;
  // Five frames, the edge frame repeated past either end: averaging fewer
  // frames there would make the window's edges look quieter than they are.
  const smoothed = levels.map((_, i) => {
    let sum = 0;
    for (let j = i - 2; j <= i + 2; j++) sum += levels[Math.min(levels.length - 1, Math.max(0, j))];
    return sum / 5;
  });
  const timeOf = (i: number) => envelope.startSec + (i + 0.5) * frameSec;
  const inside = smoothed
    .map((level, i) => ({ level, tSec: timeOf(i) }))
    .filter((frame) => frame.tSec >= fromSec && frame.tSec <= toSec);
  if (inside.length === 0) return null;

  const quietest = Math.min(...inside.map((frame) => frame.level));
  const loudest = Math.max(...inside.map((frame) => frame.level));
  const tolerance = quietest + (loudest - quietest) * 0.1;
  const candidates = inside.filter((frame) => frame.level <= tolerance);
  return candidates.sort((a, b) => Math.abs(a.tSec - preferSec) - Math.abs(b.tSec - preferSec))[0].tSec;
}
