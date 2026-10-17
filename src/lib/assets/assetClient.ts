import type { ImageAspect } from "@/lib/images/ImageProvider";

/**
 * Browser-side calls to the project illustration routes.
 *
 * Same shape as lib/jobs/jobClient: every response is parsed defensively
 * and a failure becomes one typed error carrying the server's own
 * message — "quota dépassé" or "ce fichier n'est pas une image" is
 * exactly what the panel should show, so nothing here replaces it with a
 * generic string.
 */

export class AssetClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetClientError";
  }
}

export interface ProjectAsset {
  id: string;
  mimeType: string;
  sizeBytes: number;
  origin: "upload" | "generated";
  prompt: string | null;
  providerId: string | null;
  createdAt: string;
  /** Where to fetch the bytes; the server never discloses a filesystem path. */
  url: string;
}

async function parseJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function assertOk(response: Response, json: unknown, fallback: string): Record<string, unknown> {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!response.ok || body?.ok !== true) {
    const message = body && typeof body.error === "string" ? body.error : fallback;
    throw new AssetClientError(message);
  }
  return body;
}

function parseAsset(raw: unknown): ProjectAsset {
  if (typeof raw !== "object" || raw === null) {
    throw new AssetClientError("Réponse invalide : illustration manquante.");
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.url !== "string" || typeof a.mimeType !== "string") {
    throw new AssetClientError("Réponse invalide : illustration incomplète.");
  }
  return {
    id: a.id,
    url: a.url,
    mimeType: a.mimeType,
    sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
    origin: a.origin === "generated" ? "generated" : "upload",
    prompt: typeof a.prompt === "string" ? a.prompt : null,
    providerId: typeof a.providerId === "string" ? a.providerId : null,
    createdAt: typeof a.createdAt === "string" ? a.createdAt : "",
  };
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  fallback: string
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new AssetClientError("Impossible de contacter le serveur.");
  }
  return assertOk(response, await parseJsonOrNull(response), fallback);
}

export async function listProjectAssets(
  projectId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProjectAsset[]> {
  const body = await call(
    fetchImpl,
    `/api/projects/${projectId}/assets`,
    { method: "GET" },
    "Échec du chargement des illustrations."
  );
  return Array.isArray(body.assets) ? body.assets.map(parseAsset) : [];
}

export async function uploadProjectAsset(
  projectId: string,
  file: File,
  fetchImpl: typeof fetch = fetch
): Promise<ProjectAsset> {
  const formData = new FormData();
  formData.append("file", file);
  const body = await call(
    fetchImpl,
    `/api/projects/${projectId}/assets`,
    { method: "POST", body: formData },
    "Échec de l'import de l'image."
  );
  return parseAsset(body.asset);
}

export interface GenerateProjectAssetParams {
  prompt: string;
  aspect?: ImageAspect;
  providerId?: string;
}

export async function generateProjectAsset(
  projectId: string,
  params: GenerateProjectAssetParams,
  fetchImpl: typeof fetch = fetch
): Promise<ProjectAsset> {
  const body = await call(
    fetchImpl,
    `/api/projects/${projectId}/assets/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    },
    "Échec de la génération de l'image."
  );
  return parseAsset(body.asset);
}

export async function deleteProjectAsset(
  projectId: string,
  assetId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await call(
    fetchImpl,
    `/api/projects/${projectId}/assets/${assetId}`,
    { method: "DELETE" },
    "Échec de la suppression de l'illustration."
  );
}
