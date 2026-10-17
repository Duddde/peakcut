import type { NextRequest } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteUserRepository, type User } from "./UserRepository";
import { getAuthenticatedUserFromRequest } from "./getAuthenticatedUserFromRequest";
import { resolveAppDeps } from "@/lib/appDeps";
import { resolveTrialActorFromRequest } from "@/lib/publicTrial/resolveTrialActor";
import { SqliteTrialActorRepository } from "@/lib/publicTrial/TrialActorRepository";
import { isSoloModeEnabled, resolveSoloUser } from "./soloMode";

export interface AuthenticationOptions {
  /**
   * Also accept an anonymous public-trial actor (signed trial cookie) when
   * PEAKCUT_PUBLIC_TRIAL=1. Off by default: a route only serves trial
   * visitors when it opts in explicitly — see PUBLIC_TRIAL_ACCESS.
   */
  allowPublicTrial?: boolean;
  /** Injected in tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}

/**
 * The one switch routes pass to opt into the public trial. Grepping for it
 * lists every endpoint a trial visitor can reach; everything else stays
 * account-only.
 */
export const PUBLIC_TRIAL_ACCESS: AuthenticationOptions = Object.freeze({ allowPublicTrial: true });

export type RequestActor =
  | { kind: "account"; user: User }
  | { kind: "trial"; user: User; expiresAt: string };

async function resolveAccountUser(
  request: NextRequest,
  deps: AppDeps,
  options: AuthenticationOptions
): Promise<User | null> {
  // Before any cookie or Auth.js work: in solo mode there is nothing to
  // verify, the caller *is* the single account by configuration.
  if (isSoloModeEnabled(options.env)) return resolveSoloUser(deps.db, options.env);

  const localUser = getAuthenticatedUserFromRequest(request, deps);
  if (localUser) return localUser;

  if (process.env.VITEST) return null;

  const { auth } = await import("@/auth");
  const session = await auth();
  const email = session?.user?.email;
  const internalId = session?.user?.id;
  if (!email && !internalId) return null;

  const shared = resolveAppDeps();
  const users = new SqliteUserRepository(shared.db);
  if (internalId) {
    const byId = users.findById(internalId);
    if (byId) return byId;
  }
  return email ? users.findByEmail(email) ?? null : null;
}

/**
 * Resolves who is calling: a real account (legacy signed session cookie or
 * Auth.js Google session) first, then — only with `allowPublicTrial` and
 * the flag on — an anonymous trial actor. An account always wins over a
 * trial cookie the same browser may still carry, and a trial user can
 * never be returned through the account path.
 *
 * With PEAKCUT_SOLO_USER=1 the account path short-circuits to the single
 * configured operator (see soloMode.ts) and no request is ever anonymous,
 * so routes keep their ownership checks and simply never answer 401.
 */
export async function getRequestActorAsync(
  request: NextRequest,
  deps: AppDeps,
  options: AuthenticationOptions = {}
): Promise<RequestActor | null> {
  const accountUser = await resolveAccountUser(request, deps, options);
  if (accountUser && !new SqliteTrialActorRepository(deps.db).isTrialUser(accountUser.id)) {
    return { kind: "account", user: accountUser };
  }

  if (!options.allowPublicTrial) return null;
  const trial = resolveTrialActorFromRequest(request, deps, { env: options.env, nowMs: options.nowMs });
  return trial ? { kind: "trial", user: trial.user, expiresAt: trial.expiresAt } : null;
}

/**
 * Resolves the internal PeakCut user from either the legacy signed test/session
 * cookie or the Auth.js Google session. The local cookie path remains useful
 * for isolated tests and is never used as a fallback for a missing Google
 * configuration in production. Trial actors are only returned with
 * `allowPublicTrial` (see PUBLIC_TRIAL_ACCESS).
 */
export async function getAuthenticatedUserFromRequestAsync(
  request: NextRequest,
  deps: AppDeps,
  options: AuthenticationOptions = {}
): Promise<User | null> {
  return (await getRequestActorAsync(request, deps, options))?.user ?? null;
}
