export interface CredentialsValidationResult {
  ok: boolean;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

export function validateSignupCredentials(email: unknown, password: unknown): CredentialsValidationResult {
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return { ok: false, error: "Adresse email invalide." };
  }
  if (typeof password !== "string") {
    return { ok: false, error: "Mot de passe invalide." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "Le mot de passe est trop long." };
  }
  return { ok: true };
}
