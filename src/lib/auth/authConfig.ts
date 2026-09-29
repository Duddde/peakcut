export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

const MIN_SECRET_LENGTH = 16;

/**
 * Reads the session-signing secret from the environment. Throws an
 * explicit configuration error — never falls back to a hardcoded or
 * generated-at-random-per-process default, which would silently downgrade
 * security (random-per-process secrets invalidate all sessions on every
 * restart and can't be reasoned about operationally).
 */
export function getAuthSecret(): string {
  const secret = process.env.PEAKCUT_AUTH_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new AuthConfigError(
      "PEAKCUT_AUTH_SECRET n'est pas configuré : définissez une valeur aléatoire d'au moins 16 caractères."
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(`PEAKCUT_AUTH_SECRET doit contenir au moins ${MIN_SECRET_LENGTH} caractères.`);
  }
  return secret;
}
