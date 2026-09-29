import type { WorkflowPhase, WorkflowState } from "@/lib/domain/types";

export class WorkflowStateParseError extends Error {
  constructor(message: string) {
    super(`WorkflowState invalide : ${message}`);
    this.name = "WorkflowStateParseError";
  }
}

const VALID_PHASES: WorkflowPhase[] = ["analysis_preview", "export_authorized"];

/** Shared, defensive parser for a WorkflowState crossing a network/JSON boundary. */
export function parseWorkflowState(payload: unknown): WorkflowState {
  if (typeof payload !== "object" || payload === null) {
    throw new WorkflowStateParseError("doit être un objet.");
  }
  const w = payload as Record<string, unknown>;

  if (typeof w.phase !== "string" || !VALID_PHASES.includes(w.phase as WorkflowPhase)) {
    throw new WorkflowStateParseError("phase invalide.");
  }
  if (w.publicationPolicy !== "publication_never_implicit") {
    throw new WorkflowStateParseError("publicationPolicy invalide.");
  }

  const rawRights = w.rights;
  if (typeof rawRights !== "object" || rawRights === null) {
    throw new WorkflowStateParseError("rights est manquant.");
  }
  const r = rawRights as Record<string, unknown>;
  if (typeof r.confirmed !== "boolean") {
    throw new WorkflowStateParseError("rights.confirmed doit être un booléen.");
  }

  return {
    phase: w.phase as WorkflowPhase,
    publicationPolicy: "publication_never_implicit",
    rights: {
      confirmed: r.confirmed,
      confirmedAt: typeof r.confirmedAt === "string" ? r.confirmedAt : null,
      confirmedBy: typeof r.confirmedBy === "string" ? r.confirmedBy : null,
    },
  };
}
