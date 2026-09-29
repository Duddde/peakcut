import { PUBLICATION_POLICY, type WorkflowState } from "@/lib/domain/types";

/**
 * Explicit workflow transitions for a project. Every function here is pure
 * (returns a new WorkflowState, never mutates its input) and deterministic
 * except for the current-time read used to stamp confirmations.
 *
 * Guardrail: there is no function in this module — or anywhere in PeakCut —
 * that publishes or distributes content. `authorizeExport` only ever
 * unlocks a *local* export; `publicationPolicy` stays
 * "publication_never_implicit" through every transition.
 */

export class RightsNotConfirmedError extends Error {
  constructor() {
    super(
      "Impossible d'autoriser l'export : les droits sur la source n'ont pas été confirmés par un humain."
    );
    this.name = "RightsNotConfirmedError";
  }
}

/** Thrown by consumers (e.g. the export route) when an export is attempted outside export_authorized. */
export class ExportNotAuthorizedError extends Error {
  constructor() {
    super(
      "Export refusé : ce projet n'est pas autorisé pour l'export. Confirmez les droits puis autorisez l'export."
    );
    this.name = "ExportNotAuthorizedError";
  }
}

export function createInitialWorkflow(): WorkflowState {
  return {
    phase: "analysis_preview",
    publicationPolicy: PUBLICATION_POLICY,
    rights: {
      confirmed: false,
      confirmedAt: null,
      confirmedBy: null,
    },
  };
}

export function confirmRights(workflow: WorkflowState, confirmedBy: string): WorkflowState {
  if (!confirmedBy || confirmedBy.trim().length === 0) {
    throw new Error("Un identifiant (nom ou email) est requis pour confirmer les droits.");
  }
  return {
    ...workflow,
    publicationPolicy: PUBLICATION_POLICY,
    rights: {
      confirmed: true,
      confirmedAt: new Date().toISOString(),
      confirmedBy: confirmedBy.trim(),
    },
  };
}

export function authorizeExport(workflow: WorkflowState): WorkflowState {
  if (!workflow.rights.confirmed) {
    throw new RightsNotConfirmedError();
  }
  return {
    ...workflow,
    phase: "export_authorized",
    publicationPolicy: PUBLICATION_POLICY,
  };
}

export function canExport(workflow: WorkflowState): boolean {
  return workflow.phase === "export_authorized" && workflow.rights.confirmed;
}
