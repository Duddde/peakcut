import type { WorkflowState } from "@/lib/domain/types";

/**
 * Consolidates every reason a segment export might be blocked, so the
 * export UI and the export API route show/enforce the exact same rules.
 * This is pure and side-effect free — it never touches the filesystem or
 * network; callers supply the facts (hasLocalMediaFile, durations) already
 * known to them.
 */
export interface ExportGateParams {
  workflow: WorkflowState;
  /** True only when the source is a real, locally-provided file (never a YouTube URL, which PeakCut never downloads). */
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
      "Aucun média local importé : PeakCut ne télécharge jamais automatiquement une source distante (YouTube)."
    );
  }
  if (params.hasLocalMediaFile && params.segmentEndSec > params.sourceDurationSec) {
    reasons.push("Ce segment dépasse la durée du média local importé.");
  }

  return reasons;
}

export function canExportSegment(params: ExportGateParams): boolean {
  return getExportBlockReasons(params).length === 0;
}
