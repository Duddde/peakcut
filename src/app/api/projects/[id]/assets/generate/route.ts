import { NextRequest, NextResponse } from "next/server";
import type { AppDeps } from "@/lib/appDeps";
import { resolveRouteDeps } from "@/lib/resolveRouteDeps";
import { getRequestActorAsync, PUBLIC_TRIAL_ACCESS } from "@/lib/auth/getAuthenticatedUserFromRequestAsync";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { SqliteAssetRepository } from "@/lib/assets/AssetRepository";
import { AssetStoreError, defaultAssetsBaseDir, saveAsset } from "@/lib/assets/assetStore";
import { createFixedWindowRateLimiter, type RateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";
import {
  GenerateImageRequestError,
  parseGenerateImageRequest,
} from "@/lib/images/parseGenerateImageRequest";
import { ImageProviderNotConfiguredError, type ImageProvider } from "@/lib/images/ImageProvider";
import { defaultImageProviderId, getImageProvider } from "@/lib/images/registry";
import { assetForResponse } from "../route";

/**
 * Generates an illustration from a prompt and stores it as an asset of
 * the project.
 *
 * This is the one route in PeakCut that spends money on the user's behalf,
 * and it is written accordingly.
 *
 * - A public-trial actor cannot call it at all: a trial is anonymous and
 *   its quotas are counted per job, so there is no one to bill and no
 *   limit that would hold. It answers 403 and says so, rather than
 *   silently doing nothing.
 * - Every caller is rate-limited per account, because a loop in a client
 *   would otherwise translate directly into a provider bill.
 * - An unconfigured provider answers 503, never a placeholder image.
 *
 * The prompt — the user's own words — is sent to the configured provider.
 * Nothing else about the user goes with it.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export interface GenerateAssetHandlerOptions {
  appDeps?: AppDeps;
  assetsBaseDir?: string;
  rateLimiter?: RateLimiter;
  /** Injected in tests so no real generation is ever performed. */
  providerFor?: (providerId: string) => ImageProvider;
}

/** Twenty generations an hour per account: generous for editing, useless for a runaway loop. */
const sharedRateLimiter = createFixedWindowRateLimiter({ maxRequests: 20, windowMs: 60 * 60_000 });

export function createGenerateProjectAssetHandler(options: GenerateAssetHandlerOptions = {}) {
  const rateLimiter = options.rateLimiter ?? sharedRateLimiter;

  return async function POST(request: NextRequest, context: RouteContext) {
    const depsOrError = resolveRouteDeps(options.appDeps);
    if (depsOrError instanceof NextResponse) return depsOrError;
    const deps = depsOrError;

    const actor = await getRequestActorAsync(request, deps, PUBLIC_TRIAL_ACCESS);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Non authentifié." }, { status: 401 });
    }
    if (actor.kind === "trial") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "La génération d'images par IA n'est pas disponible dans l'essai public : créez un compte pour y accéder.",
        },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const ownerId = new SqliteProjectRepository(deps.db).getProjectOwnerId(id);
    if (ownerId === null || ownerId !== actor.user.id) {
      return NextResponse.json({ ok: false, error: "Projet introuvable." }, { status: 404 });
    }

    const limited = rateLimiter.consume(`image-generation:${actor.user.id}`);
    if (!limited.allowed) {
      const response = NextResponse.json(
        { ok: false, error: "Limite de générations d'images atteinte. Réessayez plus tard." },
        { status: 429 }
      );
      if (limited.retryAfterMs) {
        response.headers.set("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      }
      return response;
    }

    let parsed;
    try {
      parsed = parseGenerateImageRequest(await request.json());
    } catch (err) {
      if (err instanceof GenerateImageRequestError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 422 });
      }
      return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
    }

    let provider: ImageProvider;
    try {
      provider = (options.providerFor ?? getImageProvider)(parsed.providerId ?? defaultImageProviderId());
    } catch {
      return NextResponse.json(
        { ok: false, error: `Fournisseur d'images inconnu : "${parsed.providerId}".` },
        { status: 422 }
      );
    }

    let generated;
    try {
      generated = await provider.generate({ prompt: parsed.prompt, aspect: parsed.aspect });
    } catch (err) {
      if (err instanceof ImageProviderNotConfiguredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
      }
      const message = err instanceof Error ? err.message : "Échec de la génération d'image.";
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }

    try {
      const record = await saveAsset(
        {
          projectId: id,
          data: generated.data,
          // Not declared: the bytes are sniffed, so a provider that
          // returns something other than what it announced is caught by
          // the same check an upload goes through.
          origin: "generated",
          prompt: generated.prompt,
          providerId: generated.providerId,
        },
        {
          baseDir: options.assetsBaseDir ?? defaultAssetsBaseDir(),
          repo: new SqliteAssetRepository(deps.db),
        }
      );
      return NextResponse.json({ ok: true, asset: assetForResponse(record) }, { status: 201 });
    } catch (err) {
      if (err instanceof AssetStoreError) {
        return NextResponse.json(
          { ok: false, error: `L'image générée a été refusée : ${err.message}` },
          { status: 502 }
        );
      }
      throw err;
    }
  };
}

export const POST = createGenerateProjectAssetHandler();
