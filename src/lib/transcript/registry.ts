import type { TranscriptProvider } from "./TranscriptProvider";
import { MockTranscriptProvider } from "./MockTranscriptProvider";
import { OpenAiTranscribeProvider } from "./OpenAiTranscribeProvider";
import { AssemblyAiProvider } from "./AssemblyAiProvider";

/**
 * Central registry of available TranscriptProvider adapters. The mock is
 * listed first and is the default for demos; real providers only activate
 * once their API key is set in the environment.
 */
export function listTranscriptProviders(): TranscriptProvider[] {
  return [new MockTranscriptProvider(), new OpenAiTranscribeProvider(), new AssemblyAiProvider()];
}

export function getTranscriptProvider(id: string): TranscriptProvider {
  const provider = listTranscriptProviders().find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Fournisseur de transcription inconnu : "${id}".`);
  }
  return provider;
}
