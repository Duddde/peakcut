import { MockTranscriptProvider } from "@/lib/transcript/MockTranscriptProvider";
import { scoreSegment } from "@/lib/scoring/scoreSegment";
import { buildDefaultSafeZones } from "@/lib/domain/defaultSafeZones";
import { buildDefaultVariants } from "@/lib/domain/defaultVariants";
import { deriveCategories } from "./deriveCategories";
import type { Segment, Transcript, TranscriptWord } from "@/lib/domain/types";

/**
 * The canonical "deterministic demo analysis" step: takes the offline mock
 * transcript and returns fully-scored, ranked, categorized segments. This
 * is the single source of truth for demo segmentation — both the
 * `/api/analyze` route and the landing page's demo project builder call
 * into this module rather than duplicating the logic.
 */

export interface RankedSegment extends Segment {
  rank: number;
  categories: string[];
}

export interface AnalyzeMockTranscriptResult {
  transcript: Transcript;
  segments: RankedSegment[];
}

function buildScoredSegment(
  projectId: string,
  id: string,
  title: string,
  words: TranscriptWord[]
): Segment {
  const startSec = words[0]?.startSec ?? 0;
  const endSec = words[words.length - 1]?.endSec ?? startSec;
  return {
    id,
    projectId,
    startSec,
    endSec,
    title,
    words,
    score: scoreSegment({ words, startSec, endSec }),
    safeZones: buildDefaultSafeZones(id),
    variants: buildDefaultVariants(id),
  };
}

export async function analyzeMockTranscript(
  projectId = "demo-project"
): Promise<AnalyzeMockTranscriptResult> {
  const provider = new MockTranscriptProvider();
  const transcript = await provider.transcribe({ mediaPath: "demo://mock-clip" });

  const hookWords = transcript.words.slice(0, 20);
  const storyWords = transcript.words.slice(20);

  const unranked = [
    buildScoredSegment(projectId, `${projectId}-segment-1`, "Le secret que personne ne partage", hookWords),
    buildScoredSegment(projectId, `${projectId}-segment-2`, "Comment j'ai progressé rapidement", storyWords),
  ];

  const ranked: RankedSegment[] = [...unranked]
    .sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0))
    .map((segment, index) => ({
      ...segment,
      rank: index + 1,
      categories: segment.score ? deriveCategories(segment.score.explanation.breakdown) : [],
    }));

  return { transcript, segments: ranked };
}
