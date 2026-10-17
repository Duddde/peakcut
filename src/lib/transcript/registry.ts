import type { TranscriptProvider } from "./TranscriptProvider";
import { OpenAiTranscribeProvider } from "./OpenAiTranscribeProvider";
import { AssemblyAiProvider } from "./AssemblyAiProvider";

/**
 * Central registry of available TranscriptProvider adapters: the ones a
 * real project can actually be transcribed with. They only activate once
 * their API key is set in the environment.
 *
 * MockTranscriptProvider is deliberately NOT here. It returns a fixed demo
 * script whatever the media, which is the right thing for the landing
 * page's canned demonstration (built directly from it in
 * analyzeMockTranscript) and for tests, but a trap on a real project: it
 * would attach a transcript that has nothing to do with the video, and
 * every downstream step — scoring, segments, burned-in subtitles — would
 * be built on it. Nothing offered through this registry ever fabricates a
 * transcript; a provider without its key fails and says so.
 */
export function listTranscriptProviders(): TranscriptProvider[] {
  return [new OpenAiTranscribeProvider(), new AssemblyAiProvider()];
}

export function getTranscriptProvider(id: string): TranscriptProvider {
  const provider = listTranscriptProviders().find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Fournisseur de transcription inconnu : "${id}".`);
  }
  return provider;
}
