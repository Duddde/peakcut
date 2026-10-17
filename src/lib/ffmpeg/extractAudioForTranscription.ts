import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Speech-oriented, deliberately small: mono, 16 kHz, 64 kbit/s MP3. That
 * is well above what a speech-to-text model needs and roughly 8 kB per
 * second of audio, so a 25 MiB upload cap fits a little under an hour of
 * material.
 */
export const TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ = 16_000;
export const TRANSCRIPTION_AUDIO_BITRATE = "64k";

export class AudioExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioExtractionError";
  }
}

export interface ExtractedAudio {
  /** Path of the extracted audio file, inside a dedicated temporary directory. */
  path: string;
  sizeBytes: number;
  /** Removes the temporary directory. Idempotent, and never throws. */
  cleanup: () => Promise<void>;
}

/** Injectable in tests, so a provider's unit tests never spawn ffmpeg. */
export type ExtractAudio = (mediaPath: string) => Promise<ExtractedAudio>;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(
        new AudioExtractionError(
          `ffmpeg est introuvable ou n'a pas pu être lancé (${err.message}). ` +
            "Installez FFmpeg pour transcrire un média volumineux."
        )
      )
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new AudioExtractionError(`ffmpeg (extraction audio) a échoué avec le code ${code}:\n${stderr.slice(-4000)}`));
    });
  });
}

/**
 * Extracts the audio track of a media file into a small, temporary MP3,
 * for providers that upload the file itself: a 20-minute 1080p video is
 * tens of megabytes of pixels a speech-to-text model never looks at, and
 * OpenAI's transcription endpoint refuses anything over 25 MiB outright.
 *
 * The caller owns the result and must call `cleanup()` — the temporary
 * file holds the user's media and has no reason to outlive the request.
 */
export async function extractAudioForTranscription(mediaPath: string): Promise<ExtractedAudio> {
  const dir = await mkdtemp(path.join(tmpdir(), "peakcut-transcribe-"));
  const outputPath = path.join(dir, "audio.mp3");
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mediaPath,
      // No video, no subtitles, no cover art — the audio track alone.
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ),
      "-c:a",
      "libmp3lame",
      "-b:a",
      TRANSCRIPTION_AUDIO_BITRATE,
      outputPath,
    ]);
    const { size } = await stat(outputPath);
    if (size <= 0) throw new AudioExtractionError("L'extraction audio a produit un fichier vide.");
    return { path: outputPath, sizeBytes: size, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
