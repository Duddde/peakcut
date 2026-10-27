import { buildPublicDemoProject } from "@/lib/demo/demoProjects";
import ProjectDetailClient from "./ProjectDetailClient";

/**
 * Server boundary for /projects/[id]. Public demo ids are resolved here so the
 * browser receives a ready project (no client-side "Chargement du projet"
 * wait). Every other id is handed to the client, which loads it through the
 * authenticated, ownership-checked /api/projects/[id] route.
 */
export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const demo = await buildPublicDemoProject(id);
  if (demo) {
    return <ProjectDetailClient projectId={id} initialProject={demo} isDemo />;
  }
  // `?url=`: a link pasted on the projects list, which the studio starts the
  // automatic pipeline on. Read here rather than from window.location, which
  // a client-side navigation has not updated yet when the page first renders.
  const { url } = (await searchParams) ?? {};
  return <ProjectDetailClient projectId={id} autoStartUrl={typeof url === "string" ? url : undefined} />;
}
