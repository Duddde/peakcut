/**
 * Whether the local email/password sign-in form is shown on /login.
 *
 * This is a *UI* switch, not a new authentication path: the underlying
 * /api/auth/signup and /api/auth/login routes already exist, already hash
 * passwords with scrypt, and already issue the same signed session cookie
 * as before. All this flag does is stop hiding them behind curl, so Google
 * OAuth isn't a prerequisite for exercising the app locally.
 *
 * Two conditions are required in production:
 *  - PEAKCUT_PASSWORD_LOGIN must be explicitly set to "1"
 *  - the existing development flag remains available for non-production tests
 *
 * Password login uses the same server-side routes and signed httpOnly session
 * cookie as the rest of the application; this flag only controls visibility
 * of the form.
 */
export function isDevLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return env.PEAKCUT_PASSWORD_LOGIN === "1";
  return env.PEAKCUT_DEV_LOGIN === "1";
}
