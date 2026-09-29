/**
 * Reports whether a provider is *configured* (its required env var is
 * present) without ever exposing the variable's name or value to a caller.
 * Used by the public /api/transcript-providers route so a client can know
 * which providers are actually usable, never what their secrets are.
 */
export function isProviderConfigured(providerId: string): boolean {
  switch (providerId) {
    case "mock-deterministic":
      return true;
    case "openai-gpt-4o-transcribe-diarize":
      return Boolean(process.env.OPENAI_API_KEY);
    case "assemblyai":
      return Boolean(process.env.ASSEMBLYAI_API_KEY);
    default:
      return false;
  }
}
