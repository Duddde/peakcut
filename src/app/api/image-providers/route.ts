import { NextResponse } from "next/server";
import { listImageProviders } from "@/lib/images/registry";
import { isImageProviderConfigured } from "@/lib/images/providerConfiguration";

/**
 * Public, secret-free directory of the image generators: id, display
 * name, and whether this deployment can actually use one. Never returns
 * an env var name or value — see isImageProviderConfigured, which reports
 * a boolean and nothing else. Mirrors /api/transcript-providers.
 */
export async function GET() {
  const providers = listImageProviders().map((provider) => ({
    id: provider.id,
    display_name: provider.displayName,
    configured: isImageProviderConfigured(provider.id),
  }));

  return NextResponse.json({ ok: true, providers });
}
