import type { Transcript } from "@/lib/domain/types";

export interface TranscriptRequest {
  /** Local path to the media file to transcribe. PeakCut never uploads or streams this elsewhere on its own. */
  mediaPath: string;
  /** BCP-47-ish language hint, e.g. "fr" or "en". Optional. */
  languageHint?: string;
}

/**
 * Adapter interface every transcript backend must implement. Concrete
 * providers (OpenAI, AssemblyAI, ...) live beside this file and only need
 * network access / API keys when actually invoked — never at import time.
 */
export interface TranscriptProvider {
  /** Stable identifier stored on Transcript.providerId. */
  readonly id: string;
  /** Human-readable name for display in the UI. */
  readonly displayName: string;
  transcribe(request: TranscriptRequest): Promise<Transcript>;
}

/** Thrown by providers that require configuration (e.g. an API key) that isn't present. */
export class TranscriptProviderNotConfiguredError extends Error {
  constructor(providerId: string, missing: string) {
    super(`Le fournisseur de transcription "${providerId}" n'est pas configuré (${missing} manquant).`);
    this.name = "TranscriptProviderNotConfiguredError";
  }
}
