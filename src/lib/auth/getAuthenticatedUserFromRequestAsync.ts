import type { NextRequest } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { SqliteUserRepository, type User } from "./UserRepository";
import { getAuthenticatedUserFromRequest } from "./getAuthenticatedUserFromRequest";
import { resolveAppDeps } from "@/lib/appDeps";

/**
 * Resolves the internal PeakCut user from either the legacy signed test/session
 * cookie or the Auth.js Google session. The local cookie path remains useful
 * for isolated tests and is never used as a fallback for a missing Google
 * configuration in production.
 */
export async function getAuthenticatedUserFromRequestAsync(
  request: NextRequest,
  deps: AppDeps
): Promise<User | null> {
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
