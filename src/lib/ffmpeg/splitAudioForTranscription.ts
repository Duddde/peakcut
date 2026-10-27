import { spawn } from "node:child_process";
import path from "node:path";
import { AudioExtractionError } from "./extractAudioForTranscription";

/**
 * Splitting a long recording into pieces a transcription model accepts.
 *
 * OpenAI's diarization model refuses any audio longer than 1400 s, so a
 * 34-minute live never got a transcript at all. Each piece is transcribed
 * on its own and the results are put back end to end (see
 * mergeChunkTranscripts). Cuts are placed in a silence whenever one is
 * close enough to the limit: a cut through a word would hand the model
 * half a syllable on each side and lose the word in both transcripts.
 */

export interface SilenceInterval {
  startSec: number;
  endSec: number;
}

export interface AudioChunkPlan {
  startSec: number;
  endSec: number;
}

export interface AudioChunkFile extends AudioChunkPlan {
  path: string;
}

/**
 * Where the pieces start and end, each at most `maxChunkSec` long.
 *
 * A piece ends in the middle of the last silence found in the final
 * quarter of its allowed length; with no silence there, it ends exactly at
 * the limit. Searching only the last quarter keeps pieces long — a cut at
 * the first pause of a long piece would multiply the requests for nothing.
 */
export function planTranscriptionChunks(
  durationSec: number,
  silences: SilenceInterval[],
  maxChunkSec: number
): AudioChunkPlan[] {
  if (!(durationSec > 0) || !(maxChunkSec > 0)) return [];
  const chunks: AudioChunkPlan[] = [];
  let start = 0;
  while (durationSec - start > maxChunkSec) {
    const latest = start + maxChunkSec;
    const earliest = start + maxChunkSec * 0.75;
    const cuts = silences
      .map((s) => (s.startSec + s.endSec) / 2)
      .filter((mid) => mid >= earliest && mid <= latest);
    const end = cuts.length > 0 ? Math.max(...cuts) : latest;
    chunks.push({ startSec: start, endSec: end });
    start = end;
  }
  chunks.push({ startSec: start, endSec: durationSec });
  return chunks;
}

/** The silences ffmpeg's silencedetect filter reports in its log. */
export function parseSilenceDetectLog(log: string): SilenceInterval[] {
  const silences: SilenceInterval[] = [];
  let pendingStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      pendingStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && pendingStart !== null) {
      silences.push({ startSec: pendingStart, endSec: Number(end[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

function runFfmpeg(args: string[], command = "ffmpeg"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new AudioExtractionError(`${command} est introuvable ou n'a pas pu être lancé (${err.message}).`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve(command === "ffprobe" ? stdout : stderr);
      else reject(new AudioExtractionError(`${command} (découpage audio) a échoué avec le code ${code}:\n${stderr.slice(-4000)}`));
    });
  });
}

/** Duration of a media file, in seconds, as ffprobe reads it. */
export async function probeMediaDurationSec(mediaPath: string): Promise<number> {
  const out = await runFfmpeg(
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mediaPath],
    "ffprobe"
  );
  const duration = Number(out.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AudioExtractionError(`Durée illisible pour ${path.basename(mediaPath)}.`);
  }
  return duration;
}

/** Injectable in tests, so a provider's unit tests never spawn ffmpeg. */
export type SplitAudio = (audioPath: string, maxChunkSec: number) => Promise<AudioChunkFile[]>;

/**
 * Cuts an extracted transcription audio file (see
 * extractAudioForTranscription) into pieces of at most `maxChunkSec`,
 * written next to it — so the extraction's own cleanup removes them too.
 *
 * Silences are those of at least 0.4 s under -35 dB: a breath between two
 * sentences, not the gap between two words.
 */
export async function splitAudioForTranscription(audioPath: string, maxChunkSec: number): Promise<AudioChunkFile[]> {
  const durationSec = await probeMediaDurationSec(audioPath);
  const log = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-af",
    "silencedetect=noise=-35dB:d=0.4",
    "-f",
    "null",
    "-",
  ]);
  const plan = planTranscriptionChunks(durationSec, parseSilenceDetectLog(log), maxChunkSec);

  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath) || ".mp3";
  const files: AudioChunkFile[] = [];
  for (const [index, chunk] of plan.entries()) {
    const chunkPath = path.join(dir, `chunk-${index}${ext}`);
    // Re-encoded rather than stream-copied: a copied MP3 can only start on
    // a frame boundary, which would shift every timestamp of the piece.
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      chunk.startSec.toFixed(3),
      "-t",
      (chunk.endSec - chunk.startSec).toFixed(3),
      "-i",
      audioPath,
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      chunkPath,
    ]);
    files.push({ ...chunk, path: chunkPath });
  }
  return files;
}
