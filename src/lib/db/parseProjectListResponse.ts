import type { ProjectStatus } from "@/lib/domain/types";

export class ProjectListResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse de liste de projets invalide : ${message}`);
    this.name = "ProjectListResponseParseError";
  }
}

export interface ParsedProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  updatedAt: string;
}

/** Defensive client-side parser for GET /api/projects. */
export function parseProjectListResponse(payload: unknown): ParsedProjectSummary[] {
  if (typeof payload !== "object" || payload === null) {
    throw new ProjectListResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (body.ok !== true) {
    throw new ProjectListResponseParseError("le champ ok doit valoir true.");
  }
  if (!Array.isArray(body.projects)) {
    throw new ProjectListResponseParseError("le champ projects doit être un tableau.");
  }

  return body.projects.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ProjectListResponseParseError(`projects[${index}] invalide.`);
    }
    const p = raw as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      typeof p.title !== "string" ||
      typeof p.status !== "string" ||
      typeof p.updatedAt !== "string"
    ) {
      throw new ProjectListResponseParseError(`projects[${index}] : champs manquants.`);
    }
    return { id: p.id, title: p.title, status: p.status as ProjectStatus, updatedAt: p.updatedAt };
  });
}
