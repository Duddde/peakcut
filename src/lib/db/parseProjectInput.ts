import { parseWorkflowState } from "@/lib/workflow/parseWorkflowState";
import {
  MOTION_CARD_KINDS,
  MOTION_CARD_POSITIONS,
  type MotionCardKind,
  type MotionCardPosition,
} from "@/lib/motion/types";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import { COMMON_LIMITATIONS } from "@/lib/effects/buildRenderPlan";
import {
  EFFECT_TEMPLATE_IDS,
  FRAMING_SHOT_SOURCES,
  type EffectTemplateId,
  type FramingShotSource,
  PERSPECTIVE_DIRECTIONS,
  PERSPECTIVE_PROFILES,
  type PerspectiveDirection,
  type PerspectiveProfile,
  type RenderPlan,
} from "@/lib/effects/types";
import type {
  Project,
  ProjectStatus,
  Score,
  Segment,
  Source,
  Timeline,
  Transcript,
  TranscriptWord,
} from "@/lib/domain/types";

export class ProjectInputParseError extends Error {
  constructor(message: string) {
    super(`Entrée de projet invalide : ${message}`);
    this.name = "ProjectInputParseError";
  }
}

const PROJECT_STATUSES: ProjectStatus[] = ["draft", "transcribing", "scoring", "ready-for-review", "approved"];

function parseWorkflowInput(raw: unknown): ReturnType<typeof parseWorkflowState> {
  try {
    return parseWorkflowState(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "workflow invalide.";
    throw new ProjectInputParseError(`workflow : ${reason}`);
  }
}

function obj(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectInputParseError(`${field} doit être un objet.`);
  }
  return raw as Record<string, unknown>;
}

function arr(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new ProjectInputParseError(`${field} doit être un tableau.`);
  }
  return raw;
}

function num(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ProjectInputParseError(`${field} doit être un nombre.`);
  }
  return raw;
}

function str(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ProjectInputParseError(`${field} doit être une chaîne.`);
  }
  return raw;
}

export function parseSourceInput(raw: unknown): Source {
  const s = obj(raw, "source");
  if (s.type !== "local-upload" && s.type !== "youtube") {
    throw new ProjectInputParseError("source.type doit être 'local-upload' ou 'youtube'.");
  }
  return {
    id: str(s.id, "source.id"),
    type: s.type,
    title: str(s.title, "source.title"),
    youtubeUrl: typeof s.youtubeUrl === "string" ? s.youtubeUrl : undefined,
    localFilePath: typeof s.localFilePath === "string" ? s.localFilePath : undefined,
    durationSec: num(s.durationSec, "source.durationSec"),
    originTimestamp: str(s.originTimestamp, "source.originTimestamp"),
    confidence: num(s.confidence, "source.confidence"),
  };
}

function parseWord(raw: unknown, field: string): TranscriptWord {
  const w = obj(raw, field);
  return {
    text: str(w.text, `${field}.text`),
    startSec: num(w.startSec, `${field}.startSec`),
    endSec: num(w.endSec, `${field}.endSec`),
    speaker: typeof w.speaker === "string" ? w.speaker : undefined,
    confidence: num(w.confidence, `${field}.confidence`),
  };
}

export function parseTranscriptInput(raw: unknown): Transcript | null {
  if (raw === null) return null;
  const t = obj(raw, "transcript");
  return {
    language: str(t.language, "transcript.language"),
    providerId: str(t.providerId, "transcript.providerId"),
    words: arr(t.words, "transcript.words").map((w, i) => parseWord(w, `transcript.words[${i}]`)),
  };
}

function parseScore(raw: unknown, field: string): Score | null {
  if (raw === null) return null;
  const s = obj(raw, field);
  const explanation = obj(s.explanation, `${field}.explanation`);
  const breakdown = obj(explanation.breakdown, `${field}.explanation.breakdown`);
  return {
    value: num(s.value, `${field}.value`),
    confidence: num(s.confidence, `${field}.confidence`),
    explanation: {
      breakdown: {
        hook: num(breakdown.hook, `${field}.explanation.breakdown.hook`),
        lexicalDensity: num(breakdown.lexicalDensity, `${field}.explanation.breakdown.lexicalDensity`),
        question: num(breakdown.question, `${field}.explanation.breakdown.question`),
        emotion: num(breakdown.emotion, `${field}.explanation.breakdown.emotion`),
        speakerChange: num(breakdown.speakerChange, `${field}.explanation.breakdown.speakerChange`),
        duration: num(breakdown.duration, `${field}.explanation.breakdown.duration`),
        penalties: num(breakdown.penalties, `${field}.explanation.breakdown.penalties`),
      },
      reasons: arr(explanation.reasons, `${field}.explanation.reasons`).map((r, i) =>
        str(r, `${field}.explanation.reasons[${i}]`)
      ),
      penaltyReasons: arr(explanation.penaltyReasons, `${field}.explanation.penaltyReasons`).map((r, i) =>
        str(r, `${field}.explanation.penaltyReasons[${i}]`)
      ),
    },
  };
}

function bool(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new ProjectInputParseError(`${field} doit être un booléen.`);
  }
  return raw;
}

/**
 * A segment's editing decisions, as edited by the user and sent back.
 *
 * Parsed strictly and then re-checked against the same bounds
 * buildRenderPlan respects (validateRenderPlan): the plan is compiled
 * into a real ffmpeg filtergraph, so an out-of-range value arriving over
 * the network is refused here rather than being clamped silently or
 * discovered at render time.
 *
 * `limitations` is not read from the client: what an export does not do
 * is the server's statement about itself, never something a caller can
 * edit away. The server's own list is substituted instead.
 */
function parseRenderPlanInput(raw: unknown, field: string): RenderPlan | null {
  if (raw === null || raw === undefined) return null;
  const p = obj(raw, field);

  const templateId = str(p.templateId, `${field}.templateId`);
  if (!EFFECT_TEMPLATE_IDS.includes(templateId as EffectTemplateId)) {
    throw new ProjectInputParseError(
      `${field}.templateId doit être l'un de : ${EFFECT_TEMPLATE_IDS.join(", ")}.`
    );
  }

  const subtitleStyle = obj(p.subtitleStyle, `${field}.subtitleStyle`);
  const audioDucking = obj(p.audioDucking, `${field}.audioDucking`);

  const plan: RenderPlan = {
    templateId: templateId as EffectTemplateId,
    intensity: num(p.intensity, `${field}.intensity`),
    cuts: arr(p.cuts, `${field}.cuts`).map((rawCut, i) => {
      const c = obj(rawCut, `${field}.cuts[${i}]`);
      return {
        startSec: num(c.startSec, `${field}.cuts[${i}].startSec`),
        endSec: num(c.endSec, `${field}.cuts[${i}].endSec`),
      };
    }),
    // Absent on every plan saved before illustrations existed, which must
    // keep loading: no overlays is a plan without illustrations, not a
    // malformed one.
    overlays: arr(p.overlays ?? [], `${field}.overlays`).map((rawOverlay, i) => {
      const at = `${field}.overlays[${i}]`;
      const o = obj(rawOverlay, at);
      const rect = obj(o.rect, `${at}.rect`);
      return {
        id: str(o.id, `${at}.id`),
        assetId: str(o.assetId, `${at}.assetId`),
        startSec: num(o.startSec, `${at}.startSec`),
        endSec: num(o.endSec, `${at}.endSec`),
        opacity: num(o.opacity, `${at}.opacity`),
        fadeSec: num(o.fadeSec, `${at}.fadeSec`),
        rect: {
          x: num(rect.x, `${at}.rect.x`),
          y: num(rect.y, `${at}.rect.y`),
          width: num(rect.width, `${at}.rect.width`),
          height: num(rect.height, `${at}.rect.height`),
        },
      };
    }),
    // Absent on every plan saved before the crop could follow a speaker,
    // which must keep loading: no shots is a clip with one static crop.
    framing: arr(p.framing ?? [], `${field}.framing`).map((rawShot, i) => {
      const at = `${field}.framing[${i}]`;
      const f = obj(rawShot, at);
      const rect = obj(f.rect, `${at}.rect`);
      const source = str(f.source, `${at}.source`);
      if (!FRAMING_SHOT_SOURCES.includes(source as FramingShotSource)) {
        throw new ProjectInputParseError(
          `${at}.source doit être l'un de : ${FRAMING_SHOT_SOURCES.join(", ")}.`
        );
      }
      return {
        id: str(f.id, `${at}.id`),
        startSec: num(f.startSec, `${at}.startSec`),
        endSec: num(f.endSec, `${at}.endSec`),
        transitionSec: num(f.transitionSec, `${at}.transitionSec`),
        source: source as FramingShotSource,
        label: f.label === null || f.label === undefined ? null : str(f.label, `${at}.label`),
        rect: {
          x: num(rect.x, `${at}.rect.x`),
          y: num(rect.y, `${at}.rect.y`),
          width: num(rect.width, `${at}.rect.width`),
          height: num(rect.height, `${at}.rect.height`),
        },
      };
    }),
    // Absent on every plan saved before 3D moves existed, which must keep
    // loading: no moves is a flat clip, not a malformed plan.
    perspectiveMoves: arr(p.perspectiveMoves ?? [], `${field}.perspectiveMoves`).map((rawMove, i) => {
      const at = `${field}.perspectiveMoves[${i}]`;
      const m = obj(rawMove, at);
      const direction = str(m.direction, `${at}.direction`);
      const profile = str(m.profile, `${at}.profile`);
      if (!PERSPECTIVE_DIRECTIONS.includes(direction as PerspectiveDirection)) {
        throw new ProjectInputParseError(
          `${at}.direction doit être l'un de : ${PERSPECTIVE_DIRECTIONS.join(", ")}.`
        );
      }
      if (!PERSPECTIVE_PROFILES.includes(profile as PerspectiveProfile)) {
        throw new ProjectInputParseError(
          `${at}.profile doit être l'un de : ${PERSPECTIVE_PROFILES.join(", ")}.`
        );
      }
      return {
        id: str(m.id, `${at}.id`),
        startSec: num(m.startSec, `${at}.startSec`),
        endSec: num(m.endSec, `${at}.endSec`),
        direction: direction as PerspectiveDirection,
        profile: profile as PerspectiveProfile,
        amount: num(m.amount, `${at}.amount`),
      };
    }),
    // Absent on plans saved before Claude Motion: no cards, not malformed.
    motion: arr(p.motion ?? [], `${field}.motion`).map((rawCard, i) => {
      const at = `${field}.motion[${i}]`;
      const c = obj(rawCard, at);
      const kind = str(c.kind, `${at}.kind`);
      const position = str(c.position, `${at}.position`);
      if (!MOTION_CARD_KINDS.includes(kind as MotionCardKind)) {
        throw new ProjectInputParseError(`${at}.kind doit être l'un de : ${MOTION_CARD_KINDS.join(", ")}.`);
      }
      if (!MOTION_CARD_POSITIONS.includes(position as MotionCardPosition)) {
        throw new ProjectInputParseError(`${at}.position doit être l'un de : ${MOTION_CARD_POSITIONS.join(", ")}.`);
      }
      return {
        id: str(c.id, `${at}.id`),
        kind: kind as MotionCardKind,
        text: str(c.text, `${at}.text`),
        detail: c.detail === null || c.detail === undefined ? null : str(c.detail, `${at}.detail`),
        items: arr(c.items ?? [], `${at}.items`).map((item, j) => str(item, `${at}.items[${j}]`)),
        startSec: num(c.startSec, `${at}.startSec`),
        endSec: num(c.endSec, `${at}.endSec`),
        position: position as MotionCardPosition,
      };
    }),
    zoomKeyframes: arr(p.zoomKeyframes, `${field}.zoomKeyframes`).map((rawKf, i) => {
      const k = obj(rawKf, `${field}.zoomKeyframes[${i}]`);
      return {
        tSec: num(k.tSec, `${field}.zoomKeyframes[${i}].tSec`),
        scale: num(k.scale, `${field}.zoomKeyframes[${i}].scale`),
      };
    }),
    subtitleStyle: {
      fontSizeScale: num(subtitleStyle.fontSizeScale, `${field}.subtitleStyle.fontSizeScale`),
      primaryColorHex: str(subtitleStyle.primaryColorHex, `${field}.subtitleStyle.primaryColorHex`),
      marginVerticalScale: num(subtitleStyle.marginVerticalScale, `${field}.subtitleStyle.marginVerticalScale`),
      emphasizeKeywords: bool(subtitleStyle.emphasizeKeywords, `${field}.subtitleStyle.emphasizeKeywords`),
    },
    safeZones: arr(p.safeZones, `${field}.safeZones`).map((rawZone, i) => {
      const z = obj(rawZone, `${field}.safeZones[${i}]`);
      const rect = obj(z.rect, `${field}.safeZones[${i}].rect`);
      return {
        id: str(z.id, `${field}.safeZones[${i}].id`),
        purpose: str(z.purpose, `${field}.safeZones[${i}].purpose`) as Segment["safeZones"][number]["purpose"],
        label: str(z.label, `${field}.safeZones[${i}].label`),
        rect: {
          x: num(rect.x, `${field}.safeZones[${i}].rect.x`),
          y: num(rect.y, `${field}.safeZones[${i}].rect.y`),
          width: num(rect.width, `${field}.safeZones[${i}].rect.width`),
          height: num(rect.height, `${field}.safeZones[${i}].rect.height`),
        },
      };
    }),
    audioDucking: {
      enabled: bool(audioDucking.enabled, `${field}.audioDucking.enabled`),
      duckDb: num(audioDucking.duckDb, `${field}.audioDucking.duckDb`),
      attackSec: num(audioDucking.attackSec, `${field}.audioDucking.attackSec`),
      releaseSec: num(audioDucking.releaseSec, `${field}.audioDucking.releaseSec`),
    },
    limitations: [...COMMON_LIMITATIONS],
  };

  const check = validateRenderPlan(plan);
  if (!check.ok) {
    throw new ProjectInputParseError(`${field} : ${check.errors.join(" ")}`);
  }
  return plan;
}

export function parseSegmentInput(raw: unknown): Segment {
  const s = obj(raw, "segment");
  const words = arr(s.words, "segment.words").map((w, i) => parseWord(w, `segment.words[${i}]`));
  const safeZones = arr(s.safeZones, "segment.safeZones").map((rawZone, i) => {
    const z = obj(rawZone, `segment.safeZones[${i}]`);
    const rect = obj(z.rect, `segment.safeZones[${i}].rect`);
    return {
      id: str(z.id, `segment.safeZones[${i}].id`),
      purpose: str(z.purpose, `segment.safeZones[${i}].purpose`) as Segment["safeZones"][number]["purpose"],
      label: str(z.label, `segment.safeZones[${i}].label`),
      rect: {
        x: num(rect.x, `segment.safeZones[${i}].rect.x`),
        y: num(rect.y, `segment.safeZones[${i}].rect.y`),
        width: num(rect.width, `segment.safeZones[${i}].rect.width`),
        height: num(rect.height, `segment.safeZones[${i}].rect.height`),
      },
    };
  });
  const variants = arr(s.variants, "segment.variants").map((rawVariant, i) => {
    const v = obj(rawVariant, `segment.variants[${i}]`);
    const crop = obj(v.crop, `segment.variants[${i}].crop`);
    return {
      id: str(v.id, `segment.variants[${i}].id`),
      label: str(v.label, `segment.variants[${i}].label`),
      aspectRatio: str(v.aspectRatio, `segment.variants[${i}].aspectRatio`) as Segment["variants"][number]["aspectRatio"],
      crop: {
        x: num(crop.x, `segment.variants[${i}].crop.x`),
        y: num(crop.y, `segment.variants[${i}].crop.y`),
        width: num(crop.width, `segment.variants[${i}].crop.width`),
        height: num(crop.height, `segment.variants[${i}].crop.height`),
      },
    };
  });

  return {
    id: str(s.id, "segment.id"),
    projectId: typeof s.projectId === "string" ? s.projectId : "",
    title: str(s.title, "segment.title"),
    startSec: num(s.startSec, "segment.startSec"),
    endSec: num(s.endSec, "segment.endSec"),
    words,
    score: parseScore(s.score ?? null, "segment.score"),
    safeZones,
    variants,
    renderPlan: parseRenderPlanInput(s.renderPlan ?? null, "segment.renderPlan"),
  };
}

export function parseTimelineInput(raw: unknown): Timeline | null {
  if (raw === null) return null;
  const t = obj(raw, "timeline");
  const clips = arr(t.clips, "timeline.clips").map((rawClip, i) => {
    const c = obj(rawClip, `timeline.clips[${i}]`);
    return {
      id: str(c.id, `timeline.clips[${i}].id`),
      trackKind: str(c.trackKind, `timeline.clips[${i}].trackKind`) as Timeline["clips"][number]["trackKind"],
      segmentId: str(c.segmentId, `timeline.clips[${i}].segmentId`),
      startSec: num(c.startSec, `timeline.clips[${i}].startSec`),
      endSec: num(c.endSec, `timeline.clips[${i}].endSec`),
    };
  });
  return { clips, totalDurationSec: num(t.totalDurationSec, "timeline.totalDurationSec") };
}

/**
 * Merges a partial PATCH body onto an already-loaded Project: every
 * top-level field is optional and, when present, independently validated
 * and structurally parsed; anything absent keeps its existing value.
 */
export function parseProjectUpdateInput(raw: unknown, existing: Project): Project {
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectInputParseError("le corps de la requête doit être un objet.");
  }
  const body = raw as Record<string, unknown>;

  const title = "title" in body ? str(body.title, "title") : existing.title;

  let status = existing.status;
  if ("status" in body) {
    if (typeof body.status !== "string" || !PROJECT_STATUSES.includes(body.status as ProjectStatus)) {
      throw new ProjectInputParseError(`status doit être l'un de : ${PROJECT_STATUSES.join(", ")}.`);
    }
    status = body.status as ProjectStatus;
  }

  const source = "source" in body ? parseSourceInput(body.source) : existing.source;
  const transcript = "transcript" in body ? parseTranscriptInput(body.transcript) : existing.transcript;
  const timeline = "timeline" in body ? parseTimelineInput(body.timeline) : existing.timeline;
  const workflow = "workflow" in body ? parseWorkflowInput(body.workflow) : existing.workflow;
  const segments = "segments" in body
    ? arr(body.segments, "segments").map((s) => parseSegmentInput(s))
    : existing.segments;

  return { ...existing, title, status, source, transcript, timeline, workflow, segments };
}

/**
 * Full parser for a GET/POST /api/projects[/id] `project` payload — every
 * field is required (unlike parseProjectUpdateInput's partial PATCH body).
 * Client-side defensive boundary parsing, same rigor as the server-side
 * parsers above (this response crossed a network boundary, even if it's
 * same-origin).
 */
export function parseProjectResponse(raw: unknown): Project {
  const p = obj(raw, "project");
  if (typeof p.status !== "string" || !PROJECT_STATUSES.includes(p.status as ProjectStatus)) {
    throw new ProjectInputParseError(`status doit être l'un de : ${PROJECT_STATUSES.join(", ")}.`);
  }
  return {
    id: str(p.id, "id"),
    title: str(p.title, "title"),
    createdAt: str(p.createdAt, "createdAt"),
    updatedAt: str(p.updatedAt, "updatedAt"),
    status: p.status as ProjectStatus,
    source: parseSourceInput(p.source),
    transcript: parseTranscriptInput(p.transcript ?? null),
    segments: arr(p.segments, "segments").map((s) => parseSegmentInput(s)),
    timeline: parseTimelineInput(p.timeline ?? null),
    workflow: parseWorkflowInput(p.workflow),
  };
}
