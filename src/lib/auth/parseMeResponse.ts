export class MeResponseParseError extends Error {
  constructor(message: string) {
    super(`Réponse /api/auth/me invalide : ${message}`);
    this.name = "MeResponseParseError";
  }
}

export interface ParsedMeUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface ParsedMeResult {
  authenticated: boolean;
  user: ParsedMeUser | null;
}

export function parseMeResponse(payload: unknown): ParsedMeResult {
  if (typeof payload !== "object" || payload === null) {
    throw new MeResponseParseError("le corps de la réponse doit être un objet.");
  }
  const body = payload as Record<string, unknown>;

  if (body.ok !== true) {
    throw new MeResponseParseError("le champ ok doit valoir true.");
  }
  if (typeof body.authenticated !== "boolean") {
    throw new MeResponseParseError("le champ authenticated doit être un booléen.");
  }

  if (!body.authenticated) {
    return { authenticated: false, user: null };
  }

  const rawUser = body.user;
  if (typeof rawUser !== "object" || rawUser === null) {
    throw new MeResponseParseError("le champ user est requis lorsque authenticated vaut true.");
  }
  const u = rawUser as Record<string, unknown>;
  if (typeof u.id !== "string" || typeof u.email !== "string" || typeof u.createdAt !== "string") {
    throw new MeResponseParseError("user est incomplet.");
  }

  return { authenticated: true, user: { id: u.id, email: u.email, createdAt: u.createdAt } };
}
