import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getRequestActorAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { describePublicTrialLimits, isPublicTrialEnabled, PUBLIC_TRIAL_LIMITS, type PublicTrialLimits } from "@/lib/publicTrial/config";
import { clearTrialCookie, setTrialCookie } from "@/lib/publicTrial/trialCookie";
import { SqliteTrialActorRepository, TrialCapacityError } from "@/lib/publicTrial/TrialActorRepository";
import {
  cleanupExpiredTrials,
  deleteTrialActorAndData,
  resolveTrialStorageRoots,
  type TrialStorageRoots,
} from "@/lib/publicTrial/cleanup";
import {
  clientIpOf,
  getSharedPublicTrialRateLimiters,
  tooManyRequests,
  type PublicTrialRateLimiters,
} from "@/lib/publicTrial/quotas";

/**
 * Public trial lifecycle (PEAKCUT_PUBLIC_TRIAL=1 only):
 *  - GET    — is the mode on, what are its limits, does this browser hold a live trial?
 *  - POST   — start (or resume) an anonymous trial: sets the signed httpOnly trial cookie;
 *  - DELETE — end the trial now: deletes its project, jobs and files, clears the cookie.
 *
 * With the flag off, GET answers `{ enabled: false }` and POST/DELETE 404,
 * so nothing about the trial exists from the outside.
 */

export interface PublicTrialRouteOptions {
  deps?: AppDeps;
  env?: NodeJS.ProcessEnv;
  limits?: PublicTrialLimits;
  rateLimiters?: PublicTrialRateLimiters;
  storageRoots?: TrialStorageRoots;
  now?: () => number;
}

function notFound() {
  return NextResponse.json({ ok: false, error: "Introuvable." }, { status: 404 });
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function createPublicTrialStatusHandler(options: PublicTrialRouteOptions = {}) {
  return async function GET(request: NextRequest) {
    const limits = options.limits ?? PUBLIC_TRIAL_LIMITS;
    if (!isPublicTrialEnabled(options.env)) {
      return noStore(NextResponse.json({ ok: true, enabled: false }));
    }

    const depsOrError = resolveRouteDeps(options.deps);
    if (depsOrError instanceof NextResponse) return depsOrError;

    const actor = await getRequestActorAsync(request, depsOrError, {
      ...PUBLIC_TRIAL_ACCESS,
      env: options.env,
      nowMs: options.now?.(),
    });
    return noStore(
      NextResponse.json({
        ok: true,
        enabled: true,
        limits: describePublicTrialLimits(limits),
        account: actor?.kind === "account",
        trial: actor?.kind === "trial" ? { active: true, expiresAt: actor.expiresAt } : null,
      })
    );
  };
}

export function createPublicTrialStartHandler(options: PublicTrialRouteOptions = {}) {
  return async function POST(request: NextRequest) {
    if (!isPublicTrialEnabled(options.env)) return notFound();
    const limits = options.limits ?? PUBLIC_TRIAL_LIMITS;
    const rateLimiters = options.rateLimiters ?? getSharedPublicTrialRateLimiters();
    const nowMs = options.now?.() ?? Date.now();

    const depsOrError = resolveRouteDeps(options.deps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, { ...PUBLIC_TRIAL_ACCESS, env: options.env, nowMs });
    if (actor?.kind === "account") {
      return NextResponse.json(
        { ok: false, error: "Vous êtes connecté : utilisez vos projets plutôt que l'essai public." },
        { status: 409 }
      );
    }
    if (actor?.kind === "trial") {
      // Idempotent: resuming never extends the TTL nor counts as a new start.
      return noStore(NextResponse.json({ ok: true, trial: { active: true, expiresAt: actor.expiresAt }, resumed: true }));
    }

    const limited = rateLimiters.starts.consume(`trial-start:${clientIpOf(request)}`);
    if (!limited.allowed) {
      return tooManyRequests("Trop d'essais démarrés depuis cette adresse. Réessayez plus tard.", limited.retryAfterMs);
    }

    // Opportunistic: free the capacity (and disk) held by expired trials
    // before counting live ones against maxActiveTrials.
    await cleanupExpiredTrials(deps.db, { roots: options.storageRoots ?? resolveTrialStorageRoots(), nowMs });

    let created;
    try {
      created = new SqliteTrialActorRepository(deps.db).create({
        nowMs,
        ttlMs: limits.ttlMs,
        maxActive: limits.maxActiveTrials,
      });
    } catch (err) {
      if (err instanceof TrialCapacityError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
      }
      throw err;
    }

    const response = noStore(
      NextResponse.json(
        { ok: true, trial: { active: true, expiresAt: created.expiresAt }, limits: describePublicTrialLimits(limits) },
        { status: 201 }
      )
    );
    setTrialCookie(response, { actorId: created.userId, expiresAtMs: new Date(created.expiresAt).getTime() }, deps.authSecret, nowMs);
    return response;
  };
}

export function createPublicTrialEndHandler(options: PublicTrialRouteOptions = {}) {
  return async function DELETE(request: NextRequest) {
    if (!isPublicTrialEnabled(options.env)) return notFound();

    const depsOrError = resolveRouteDeps(options.deps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, { ...PUBLIC_TRIAL_ACCESS, env: options.env, nowMs: options.now?.() });
    const response = NextResponse.json({ ok: true });
    if (actor?.kind === "trial") {
      await deleteTrialActorAndData(deps.db, actor.user.id, { roots: options.storageRoots ?? resolveTrialStorageRoots() });
    }
    clearTrialCookie(response);
    return noStore(response);
  };
}

export const GET = createPublicTrialStatusHandler();
export const POST = createPublicTrialStartHandler();
export const DELETE = createPublicTrialEndHandler();
