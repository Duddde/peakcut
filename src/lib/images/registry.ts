import type { ImageProvider } from "./ImageProvider";
import { OpenAiImageProvider } from "./OpenAiImageProvider";

/**
 * The image backends a real project can generate an illustration with.
 * One today; the registry exists so adding another changes one list and
 * nothing else — the same shape lib/transcript's registry has.
 *
 * There is no mock provider here on purpose. A stand-in that returned a
 * coloured rectangle would be indistinguishable, in the app, from a real
 * generation that silently failed.
 */
export function listImageProviders(): ImageProvider[] {
  return [new OpenAiImageProvider()];
}

export function getImageProvider(id: string): ImageProvider {
  const provider = listImageProviders().find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Fournisseur d'images inconnu : "${id}".`);
  }
  return provider;
}

/** The provider used when a request does not name one. */
export function defaultImageProviderId(): string {
  return listImageProviders()[0].id;
}
