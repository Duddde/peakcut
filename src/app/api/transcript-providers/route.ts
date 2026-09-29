import { NextResponse } from "next/server";
import { listTranscriptProviders } from "@/lib/transcript/registry";
import { isProviderConfigured } from "@/lib/transcript/providerConfiguration";

/**
 * Public, secret-free provider directory: only id/display name/whether a
 * provider is currently usable. Never returns an env var name or value —
 * see isProviderConfigured, which reports a boolean and nothing else.
 */
export async function GET() {
  const providers = listTranscriptProviders().map((provider) => ({
    id: provider.id,
    display_name: provider.displayName,
    configured: isProviderConfigured(provider.id),
  }));

  return NextResponse.json({ ok: true, providers });
}
