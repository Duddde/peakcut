import { NextRequest, NextResponse } from "next/server";
import { analyzeMockTranscript } from "@/lib/analysis/analyzeMockTranscript";

/**
 * Deterministic demo analysis endpoint. Takes the offline mock transcript
 * (no real speech-to-text, no network call) and returns ranked segments
 * with a fully explainable score breakdown, categories, reasons and
 * confidence. The JSON contract intentionally uses snake_case keys.
 *
 * This never claims to predict watch time or virality — see reasons/
 * score_breakdown, which are the same explainable heuristics used
 * throughout PeakCut.
 */
export async function POST(request: NextRequest) {
  try {
    await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { segments } = await analyzeMockTranscript();

  return NextResponse.json({
    ok: true,
    segments: segments.map((segment) => ({
      id: segment.id,
      rank: segment.rank,
      title: segment.title,
      start_sec: segment.startSec,
      end_sec: segment.endSec,
      score: segment.score?.value ?? 0,
      confidence: segment.score?.confidence ?? 0,
      score_breakdown: segment.score
        ? {
            hook: segment.score.explanation.breakdown.hook,
            lexical_density: segment.score.explanation.breakdown.lexicalDensity,
            question: segment.score.explanation.breakdown.question,
            emotion: segment.score.explanation.breakdown.emotion,
            speaker_change: segment.score.explanation.breakdown.speakerChange,
            duration: segment.score.explanation.breakdown.duration,
            penalties: segment.score.explanation.breakdown.penalties,
          }
        : null,
      categories: segment.categories,
      reasons: segment.score?.explanation.reasons ?? [],
      penalty_reasons: segment.score?.explanation.penaltyReasons ?? [],
      words: segment.words.map((word) => ({
        text: word.text,
        start_sec: word.startSec,
        end_sec: word.endSec,
        speaker: word.speaker ?? null,
        confidence: word.confidence,
      })),
      safe_zones: segment.safeZones.map((zone) => ({
        id: zone.id,
        purpose: zone.purpose,
        label: zone.label,
        rect: zone.rect,
      })),
      variants: segment.variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        aspect_ratio: variant.aspectRatio,
        crop: variant.crop,
      })),
    })),
  });
}
