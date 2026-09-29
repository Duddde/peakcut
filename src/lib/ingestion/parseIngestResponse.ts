import type { Source, WorkflowState } from "@/lib/domain/types";
import { parseWorkflowState } from "@/lib/workflow/parseWorkflowState";

export class IngestResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse d'ingestion invalide : ${message}`);
    this.name = "IngestResponseParseError";
  }
}

export interface ParsedIngestResult {
  source: Source;
  workflow: WorkflowState;
}

export function parseIngestResponse(payload: unknown): ParsedIngestResult {
  if (typeof payload !== "object" || payload === null) {
    throw new IngestResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) {
    throw new IngestResponseParseError("le champ ok doit valoir true.");
  }

  const rawSource = body.source;
  if (typeof rawSource !== "object" || rawSource === null) {
    throw new IngestResponseParseError("le champ source est manquant.");
  }
  const s = rawSource as Record<string, unknown>;
  if (s.type !== "local-upload" && s.type !== "youtube") {
    throw new IngestResponseParseError("source.type doit être 'local-upload' ou 'youtube'.");
  }
  if (
    typeof s.id !== "string" ||
    typeof s.title !== "string" ||
    typeof s.durationSec !== "number" ||
    typeof s.originTimestamp !== "string" ||
    typeof s.confidence !== "number"
  ) {
    throw new IngestResponseParseError("source est incomplète.");
  }

  const source: Source = {
    id: s.id,
    type: s.type,
    title: s.title,
    durationSec: s.durationSec,
    originTimestamp: s.originTimestamp,
    confidence: s.confidence,
    localFilePath: typeof s.localFilePath === "string" ? s.localFilePath : undefined,
    youtubeUrl: typeof s.youtubeUrl === "string" ? s.youtubeUrl : undefined,
  };

  let workflow;
  try {
    workflow = parseWorkflowState(body.workflow);
  } catch {
    throw new IngestResponseParseError("le champ workflow est invalide.");
  }

  return { source, workflow };
}
