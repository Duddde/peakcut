export class ProviderListResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse de liste de fournisseurs invalide : ${message}`);
    this.name = "ProviderListResponseParseError";
  }
}

export interface ParsedProviderOption {
  id: string;
  displayName: string;
  configured: boolean;
}

/** Defensive client-side parser for the GET /api/transcript-providers JSON contract. */
export function parseProviderListResponse(payload: unknown): ParsedProviderOption[] {
  if (typeof payload !== "object" || payload === null) {
    throw new ProviderListResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (body.ok !== true) {
    throw new ProviderListResponseParseError("le champ ok doit valoir true.");
  }
  if (!Array.isArray(body.providers)) {
    throw new ProviderListResponseParseError("le champ providers doit être un tableau.");
  }

  return body.providers.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ProviderListResponseParseError(`providers[${index}] invalide.`);
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || typeof p.display_name !== "string" || typeof p.configured !== "boolean") {
      throw new ProviderListResponseParseError(`providers[${index}] : champs manquants.`);
    }
    return { id: p.id, displayName: p.display_name, configured: p.configured };
  });
}
