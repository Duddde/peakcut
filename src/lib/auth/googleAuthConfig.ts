export class GoogleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthConfigError";
  }
}

export interface GoogleAuthConfig {
  authSecret: string;
  googleClientId: string;
  googleClientSecret: string;
}

/** Reads Google OAuth configuration without exposing secret values. */
export function getGoogleAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleAuthConfig {
  const authSecret = env.AUTH_SECRET ?? env.PEAKCUT_AUTH_SECRET ?? "";
  const googleClientId = env.AUTH_GOOGLE_ID ?? "";
  const googleClientSecret = env.AUTH_GOOGLE_SECRET ?? "";
  const missing: string[] = [];

  if (authSecret.length < 32) missing.push("AUTH_SECRET");
  if (googleClientId.trim().length === 0) missing.push("AUTH_GOOGLE_ID");
  if (googleClientSecret.trim().length === 0) missing.push("AUTH_GOOGLE_SECRET");
  if (missing.length > 0) {
    throw new GoogleAuthConfigError(`Configuration Google OAuth incomplète : ${missing.join(", ")}.`);
  }

  return { authSecret, googleClientId, googleClientSecret };
}
