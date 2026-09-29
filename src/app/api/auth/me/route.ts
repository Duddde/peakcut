import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getAuthenticatedUserFromRequestAsync } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";

/**
 * "Whoami" endpoint. Always answers 200 with an explicit `authenticated`
 * boolean — checking your own auth status is not itself an error, so a
 * logged-out caller doesn't need special-case handling for a 401. Never
 * includes a password hash or any secret; `authenticated: false` carries
 * no further detail about *why* (expired vs. missing vs. invalid), which
 * is deliberate — that distinction is never useful to the client and
 * would only add a way to leak internal state.
 */
export function createMeHandler(injectedDeps?: AppDeps) {
  return async function GET(request: NextRequest) {
    const depsOrError = resolveRouteDeps(injectedDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const user = await getAuthenticatedUserFromRequestAsync(request, deps);
    if (!user) {
      return NextResponse.json({ ok: true, authenticated: false });
    }
    return NextResponse.json({ ok: true, authenticated: true, user });
  };
}

export const GET = createMeHandler();
