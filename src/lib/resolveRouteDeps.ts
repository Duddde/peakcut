import { NextResponse } from "next/server";
import { resolveAppDeps, type AppDeps } from "./appDeps";

/**
 * Shared by every DB/auth-backed route: returns injected deps as-is (for
 * tests), or lazily resolves the real ones — surfacing DatabaseConfigError
 * / AuthConfigError as an explicit 500 response rather than ever falling
 * back to an insecure default. Must only be called from inside a request
 * handler, never at module load time.
 */
export function resolveRouteDeps(injected?: AppDeps): AppDeps | NextResponse {
  if (injected) return injected;
  try {
    return resolveAppDeps();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Configuration serveur invalide.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
