import type { WorkflowState } from "@/lib/domain/types";

/**
 * Consolidates every reason a segment export might be blocked, so the
 * export UI and the export API route show/enforce the exact same rules.
 * This is pure and side-effect free — it never touches the filesystem or
 * network; callers supply the facts (hasMediaFile, durations) already
 * known to them.
 *
 * Note that having the bytes on disk is necessary but never sufficient:
 * a downloaded YouTube source passes `hasMediaFile` like any local
 * import, and still cannot be exported until a human has confirmed the
 * rights and explicitly authorized the export.
 */
export interface ExportGateParams {
  workflow: WorkflowState;
  /** True when a real media file exists on disk for this source — a local import, or a YouTube video PeakCut has downloaded. */
  hasLocalMediaFile: boolean;
  segmentEndSec: number;
  sourceDurationSec: number;
}

export function getExportBlockReasons(params: ExportGateParams): string[] {
  const reasons: string[] = [];

  if (!params.workflow.rights.confirmed) {
    reasons.push("Les droits sur la source ne sont pas encore confirmés par un humain.");
  }
  if (params.workflow.phase !== "export_authorized") {
    reasons.push("L'export n'a pas été explicitement autorisé pour ce projet.");
  }
  if (!params.hasLocalMediaFile) {
    reasons.push(
      "Aucun fichier média disponible : importez un média local ou téléchargez la source YouTube du projet."
    );
  }
  if (params.hasLocalMediaFile && params.segmentEndSec > params.sourceDurationSec) {
    reasons.push("Ce segment dépasse la durée du média disponible.");
  }

  return reasons;
}

export function canExportSegment(params: ExportGateParams): boolean {
  return getExportBlockReasons(params).length === 0;
}
