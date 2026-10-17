import type { TranscriptWord } from "@/lib/domain/types";
import { buildRenderPlan } from "./buildRenderPlan";
import type { EffectTemplateId, RenderPlan } from "./types";

/**
 * The editing plan a freshly-cut clip starts from, so a candidate is a
 * finished edit the moment it appears rather than a bare cut the user has
 * to dress themselves.
 *
 * Nothing here is a guess about what will perform: it reads one fact off
 * the transcript — does anyone else speak in this clip — and picks the
 * template built for that shape. The user can change it afterwards, and
 * the plan is stored on the segment precisely so their change sticks.
 */

export interface DefaultRenderPlanInput {
  segmentId: string;
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
}

/**
 * When the speaker changes, in seconds from the start of the clip.
 *
 * Only changes *inside* the clip count: the first word is where the clip
 * opens, not a cut to react to. Timestamps are made relative because a
 * RenderPlan's keyframes live on the exported clip's own timeline, which
 * starts at 0.
 */
export function speakerChangeTimesWithin(words: TranscriptWord[], startSec: number): number[] {
  const times: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1].speaker;
    const current = words[i].speaker;
    if (previous !== undefined && current !== undefined && previous !== current) {
      times.push(Math.max(0, words[i].startSec - startSec));
    }
  }
  return times;
}

/**
 * The template a clip starts on: "speaker-focus" when it holds an
 * exchange (its punches land on the speaker changes), "subtle-punch" for
 * a single voice (one slow push in and back out).
 */
export function defaultTemplateFor(speakerChangeCount: number): EffectTemplateId {
  return speakerChangeCount > 0 ? "speaker-focus" : "subtle-punch";
}

export function defaultRenderPlanFor(input: DefaultRenderPlanInput): RenderPlan {
  const speakerChangeTimesSec = speakerChangeTimesWithin(input.words, input.startSec);
  return buildRenderPlan(defaultTemplateFor(speakerChangeTimesSec.length), {
    segmentId: input.segmentId,
    segmentDurationSec: Math.max(0, input.endSec - input.startSec),
    speakerChangeTimesSec,
  });
}
