/**
 * Whether an export needs a human to have confirmed the rights on the
 * source first (see exportGate).
 *
 * Under `next dev` the operator is testing their own instance on videos
 * they picked themselves: the attestation is a box to tick before every
 * first render, protecting no one. It is therefore skipped in development
 * and enforced everywhere else — production, but also the test suite and
 * a worker started outside `next dev` (`npm run worker` leaves NODE_ENV
 * unset), which keep the gate exactly as it was.
 *
 * Server-only and read per call, like the other environment switches: the
 * studio learns the answer from GET /api/projects/[id], never from a
 * NEXT_PUBLIC_ variable a production build could carry over by mistake.
 */
export function isRightsConfirmationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "development";
}
