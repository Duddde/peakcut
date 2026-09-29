import { parseWorkflowState } from "@/lib/workflow/parseWorkflowState";
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
