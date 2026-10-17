/**
 * Reports whether an image provider is *configured* (its required env var
 * is present) without ever exposing the variable's name or value to a
 * caller — same contract as lib/transcript's providerConfiguration, used
 * by /api/image-providers so the studio can grey out a generator it
 * cannot actually run.
 */
export function isImageProviderConfigured(providerId: string): boolean {
  switch (providerId) {
    case "openai-gpt-image-1":
      return Boolean(process.env.OPENAI_API_KEY);
    default:
      return false;
  }
}
