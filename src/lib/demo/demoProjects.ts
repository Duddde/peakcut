import type { Project } from "@/lib/domain/types";
import { buildDemoProject } from "./buildDemoProject";

/**
 * Public demonstration content for the exploration mode of /projects and
 * /projects/[id]. Every entry is built from buildDemoProject — deterministic,
 * offline, and owned by nobody — so showing it without a session can never
 * leak a real user's project. Only the ids listed here are treated as
 * public; any other id goes through the authenticated, ownership-checked
 * /api/projects/[id] route.
 */

export interface DemoProjectSummary {
  id: string;
  title: string;
  format: string;
  sourceTitle: string;
  durationSec: number;
  segmentCount: number;
  topScore: number;
  status: Project["status"];
}

const DEMO_VARIANTS = [
  { id: "demo-project", title: "Démo PeakCut — vidéo d'exemple", format: "Talk" },
  { id: "demo-podcast", title: "Podcast · Les signaux faibles", format: "Podcast" },
  { id: "demo-interview", title: "Interview · Construire en public", format: "Interview" },
] as const;

export const DEFAULT_DEMO_PROJECT_ID = DEMO_VARIANTS[0].id;

export function isDemoProjectId(id: string): boolean {
  return DEMO_VARIANTS.some((variant) => variant.id === id);
}

/** The demo project for a public id, or null when the id is not a demo one. */
export async function buildPublicDemoProject(id: string): Promise<Project | null> {
  const variant = DEMO_VARIANTS.find((candidate) => candidate.id === id);
  if (!variant) return null;
  const project = await buildDemoProject();
  return { ...project, id: variant.id, title: variant.title };
}

export async function listDemoProjectSummaries(): Promise<DemoProjectSummary[]> {
  const project = await buildDemoProject();
  const topScore = Math.max(0, ...project.segments.map((segment) => segment.score?.value ?? 0));
  return DEMO_VARIANTS.map((variant) => ({
    id: variant.id,
    title: variant.title,
    format: variant.format,
    sourceTitle: project.source.title,
    durationSec: project.source.durationSec,
    segmentCount: project.segments.length,
    topScore: Math.round(topScore),
    status: project.status,
  }));
}
