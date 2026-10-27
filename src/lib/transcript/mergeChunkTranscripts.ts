import type { Transcript } from "@/lib/domain/types";

/** Joins a speaker label to the number of the piece it was heard in: "A" of piece 2 is "A·2". */
const PIECE_SEPARATOR = "·";

export interface ChunkTranscript {
  /** Where the piece starts in the whole recording, in seconds. */
  offsetSec: number;
  transcript: Transcript;
}

/**
 * One transcript for the whole recording, from the transcripts of its
 * pieces (see splitAudioForTranscription).
 *
 * Each piece's timestamps are relative to its own start, so they are moved
 * by its offset. Speaker labels are made distinct per piece ("A" becomes
 * "A·1", "A·2"…): the model labels every request from scratch, and nothing
 * says the "A" of the second piece is the "A" of the first. Merging them
 * would invent a continuity that was never measured.
 */
export function mergeChunkTranscripts(chunks: ChunkTranscript[], providerId: string): Transcript {
  const ordered = [...chunks].sort((a, b) => a.offsetSec - b.offsetSec);
  const relabel = ordered.length > 1;
  return {
    language: ordered.find((c) => c.transcript.language)?.transcript.language ?? "",
    providerId,
    words: ordered.flatMap((chunk, index) =>
      chunk.transcript.words.map((word) => ({
        ...word,
        startSec: word.startSec + chunk.offsetSec,
        endSec: word.endSec + chunk.offsetSec,
        speaker:
          relabel && word.speaker !== undefined ? `${word.speaker}${PIECE_SEPARATOR}${index + 1}` : word.speaker,
      }))
    ),
  };
}
