import type { NormalizedRect, SafeZone, TranscriptWord, WorkflowState } from "@/lib/domain/types";
import { parseWorkflowState } from "@/lib/workflow/parseWorkflowState";
import { EFFECT_TEMPLATE_IDS, type RenderPlan } from "@/lib/effects/types";

export class ExportRequestParseError extends Error {
  constructor(message: string) {
    super(`Requête d'export invalide : ${message}`);
    this.name = "ExportRequestParseError";
  }
}

export interface ExportRequestBody {
  sourcePath: string;
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
  crop?: NormalizedRect;
  workflow: WorkflowState;
  /**
   * Optional declarative effect plan. This is a *structural* parse only —
   * numeric bounds (zoom scale, ducking dB, etc.) are re-checked at export
   * time by validateRenderPlan, which may safely fall back rather than
   * reject the whole request.
   */
  renderPlan?: RenderPlan;
}

function parseCrop(raw: unknown): NormalizedRect | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new ExportRequestParseError("crop doit être un objet.");
  }
  const c = raw as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof c[key] !== "number") {
      throw new ExportRequestParseError(`crop.${key} doit être un nombre.`);
    }
  }
  return { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number };
}

function parseWords(raw: unknown): TranscriptWord[] {
  if (!Array.isArray(raw)) {
    throw new ExportRequestParseError("words doit être un tableau.");
  }
  return raw.map((rawWord, index) => {
    if (typeof rawWord !== "object" || rawWord === null) {
      throw new ExportRequestParseError(`words[${index}] invalide.`);
    }
    const w = rawWord as Record<string, unknown>;
    if (
      typeof w.text !== "string" ||
      typeof w.start_sec !== "number" ||
      typeof w.end_sec !== "number" ||
      typeof w.confidence !== "number"
    ) {
      throw new ExportRequestParseError(`words[${index}] : champs manquants.`);
    }
    return {
      text: w.text,
      startSec: w.start_sec,
      endSec: w.end_sec,
      speaker: typeof w.speaker === "string" ? w.speaker : undefined,
      confidence: w.confidence,
    };
  });
}

function requireArray(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new ExportRequestParseError(`renderPlan.${field} doit être un tableau.`);
  }
  return raw;
}

function requireNumber(raw: unknown, field: string): number {
  if (typeof raw !== "number") {
    throw new ExportRequestParseError(`renderPlan.${field} doit être un nombre.`);
  }
  return raw;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ExportRequestParseError(`renderPlan.${field} doit être une chaîne.`);
  }
  return raw;
}

function requireBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new ExportRequestParseError(`renderPlan.${field} doit être un booléen.`);
  }
  return raw;
}

function requireObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new ExportRequestParseError(`renderPlan.${field} est requis.`);
  }
  return raw as Record<string, unknown>;
}

function parseRenderPlan(raw: unknown): RenderPlan {
  const plan = requireObject(raw, "");

  const templateId = requireString(plan.templateId, "templateId");
  if (!EFFECT_TEMPLATE_IDS.includes(templateId as RenderPlan["templateId"])) {
    throw new ExportRequestParseError(`renderPlan.templateId inconnu : "${templateId}".`);
  }

  const cuts = requireArray(plan.cuts, "cuts").map((raw, index) => {
    const c = requireObject(raw, `cuts[${index}]`);
    return { startSec: requireNumber(c.startSec, `cuts[${index}].startSec`), endSec: requireNumber(c.endSec, `cuts[${index}].endSec`) };
  });

  const zoomKeyframes = requireArray(plan.zoomKeyframes, "zoomKeyframes").map((raw, index) => {
    const k = requireObject(raw, `zoomKeyframes[${index}]`);
    return { tSec: requireNumber(k.tSec, `zoomKeyframes[${index}].tSec`), scale: requireNumber(k.scale, `zoomKeyframes[${index}].scale`) };
  });

  const styleRaw = requireObject(plan.subtitleStyle, "subtitleStyle");
  const subtitleStyle = {
    fontSizeScale: requireNumber(styleRaw.fontSizeScale, "subtitleStyle.fontSizeScale"),
    primaryColorHex: requireString(styleRaw.primaryColorHex, "subtitleStyle.primaryColorHex"),
    marginVerticalScale: requireNumber(styleRaw.marginVerticalScale, "subtitleStyle.marginVerticalScale"),
    emphasizeKeywords: requireBoolean(styleRaw.emphasizeKeywords, "subtitleStyle.emphasizeKeywords"),
  };

  const safeZones = requireArray(plan.safeZones, "safeZones").map((raw, index) => {
    const z = requireObject(raw, `safeZones[${index}]`);
    const rect = requireObject(z.rect, `safeZones[${index}].rect`);
    return {
      id: requireString(z.id, `safeZones[${index}].id`),
      purpose: requireString(z.purpose, `safeZones[${index}].purpose`) as SafeZone["purpose"],
      label: requireString(z.label, `safeZones[${index}].label`),
      rect: {
        x: requireNumber(rect.x, `safeZones[${index}].rect.x`),
        y: requireNumber(rect.y, `safeZones[${index}].rect.y`),
        width: requireNumber(rect.width, `safeZones[${index}].rect.width`),
        height: requireNumber(rect.height, `safeZones[${index}].rect.height`),
      },
    };
  });

  const duckingRaw = requireObject(plan.audioDucking, "audioDucking");
  const audioDucking = {
    enabled: requireBoolean(duckingRaw.enabled, "audioDucking.enabled"),
    duckDb: requireNumber(duckingRaw.duckDb, "audioDucking.duckDb"),
    attackSec: requireNumber(duckingRaw.attackSec, "audioDucking.attackSec"),
    releaseSec: requireNumber(duckingRaw.releaseSec, "audioDucking.releaseSec"),
  };

  const limitations = requireArray(plan.limitations, "limitations").map((l, index) =>
    requireString(l, `limitations[${index}]`)
  );

  return {
    templateId: templateId as RenderPlan["templateId"],
    intensity: requireNumber(plan.intensity, "intensity"),
    cuts,
    zoomKeyframes,
    subtitleStyle,
    safeZones,
    audioDucking,
    limitations,
  };
}

export function parseExportRequestBody(payload: unknown): ExportRequestBody {
  if (typeof payload !== "object" || payload === null) {
    throw new ExportRequestParseError("le corps de la requête doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (typeof body.sourcePath !== "string" || body.sourcePath.trim().length === 0) {
    throw new ExportRequestParseError("sourcePath est requis.");
  }
  if (body.sourcePath.includes("..")) {
    throw new ExportRequestParseError("sourcePath ne doit pas contenir de séquence de parcours de chemin.");
  }

  if (typeof body.startSec !== "number" || typeof body.endSec !== "number") {
    throw new ExportRequestParseError("startSec/endSec doivent être des nombres.");
  }
  if (!(body.endSec > body.startSec)) {
    throw new ExportRequestParseError("endSec doit être strictement supérieur à startSec.");
  }

  const words = parseWords(body.words);
  const crop = parseCrop(body.crop);

  let workflow: WorkflowState;
  try {
    workflow = parseWorkflowState(body.workflow);
  } catch {
    throw new ExportRequestParseError("workflow est manquant ou invalide.");
  }

  let renderPlan: RenderPlan | undefined;
  if (body.renderPlan !== undefined) {
    renderPlan = parseRenderPlan(body.renderPlan);
  }

  return {
    sourcePath: body.sourcePath,
    startSec: body.startSec,
    endSec: body.endSec,
    words,
    crop,
    workflow,
    renderPlan,
  };
}
