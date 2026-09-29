/**
 * Whether the local email/password sign-in form is shown on /login.
 *
 * This is a *UI* switch, not a new authentication path: the underlying
 * /api/auth/signup and /api/auth/login routes already exist, already hash
 * passwords with scrypt, and already issue the same signed session cookie
 * as before. All this flag does is stop hiding them behind curl, so Google
 * OAuth isn't a prerequisite for exercising the app locally.
 *
 * Two conditions, both required, so it can never be on by accident:
 *  - PEAKCUT_DEV_LOGIN must be explicitly set to "1"
 *  - NODE_ENV must not be "production"
 *
 * The second condition is deliberately not overridable. Setting the env var
 * on a production build does nothing — a forgotten variable in a deploy
 * config must not be able to put a password form on a public login page.
 */
export function isDevLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return env.PEAKCUT_DEV_LOGIN === "1";
}
