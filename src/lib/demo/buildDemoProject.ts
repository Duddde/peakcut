import { analyzeMockTranscript } from "@/lib/analysis/analyzeMockTranscript";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { Project, Segment, Timeline } from "@/lib/domain/types";

/**
 * Builds a fully-formed demo Project entirely from the deterministic mock
 * transcript provider — no network access, no media file required. This is
 * what powers the landing page's live editor demonstration so the data
 * model (Project/Source/Segment/Score/SafeZone/Timeline/Variant/Workflow)
 * can be shown working end to end before a user ever uploads real media.
 *
 * Segmentation, scoring, safe zones and crop variants are computed by
 * analyzeMockTranscript — the same function backing the /api/analyze route
 * — so the landing page demo and the API contract never drift apart.
 */

const DEMO_PROJECT_ID = "demo-project";

function buildTimeline(segments: Segment[]): Timeline {
  const clips = segments.flatMap((segment) => [
    {
      id: `${segment.id}-clip-video`,
      trackKind: "video" as const,
      segmentId: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
    },
    {
      id: `${segment.id}-clip-subtitle`,
      trackKind: "subtitle" as const,
      segmentId: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
    },
  ]);
  const totalDurationSec = Math.max(0, ...segments.map((s) => s.endSec));
  return { clips, totalDurationSec };
}

export async function buildDemoProject(): Promise<Project> {
  const { transcript, segments } = await analyzeMockTranscript(DEMO_PROJECT_ID);

  const now = new Date().toISOString();

  return {
    id: DEMO_PROJECT_ID,
    title: "Démo PeakCut — vidéo d'exemple",
    createdAt: now,
    updatedAt: now,
    status: "ready-for-review",
    source: {
      id: "demo-source",
      type: "local-upload",
      title: "clip-demo-local.mp4",
      durationSec: transcript.words[transcript.words.length - 1]?.endSec ?? 0,
      originTimestamp: now,
      confidence: 1,
    },
    transcript,
    segments,
    timeline: buildTimeline(segments),
    workflow: createInitialWorkflow(),
  };
}
